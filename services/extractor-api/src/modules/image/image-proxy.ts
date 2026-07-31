import { lookup } from "node:dns/promises";

import { isPublicIpAddress, type ResolveHostname } from "../extract/source-url-safety.js";

import type { FastifyInstance } from "fastify";

const allowedWidths = new Set([96, 480, 1200]);
const allowedContentTypes = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);
const blockedHostnames = new Set(["localhost", "localhost."]);
const maxRedirects = 3;
const maxImageBytes = 5 * 1024 * 1024;
const dnsTimeoutMs = 2_000;
const totalTimeoutMs = 5_000;

type ImageProxyRejectionReason =
  | "credentials_not_allowed"
  | "dns_lookup_failed"
  | "image_too_large"
  | "invalid_content_type"
  | "invalid_image_bytes"
  | "private_address"
  | "redirect_limit"
  | "source_unreachable"
  | "unsupported_protocol";

export class ImageProxyError extends Error {
  public constructor(
    message: string,
    public readonly reason: ImageProxyRejectionReason,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "ImageProxyError";
  }
}

type SharpPipeline = {
  resize(options: { fit: "inside"; width: number; withoutEnlargement: boolean }): SharpPipeline;
  rotate(): SharpPipeline;
  toBuffer(): Promise<Buffer>;
  webp(options: { quality: number }): SharpPipeline;
};

type SharpFactory = (input: Buffer, options?: { failOn?: "none" }) => SharpPipeline;

export type ImageProxyDependencies = {
  fetchImplementation?: typeof fetch;
  loadSharp?: () => Promise<SharpFactory>;
  resolveHostname?: ResolveHostname;
};

const isBlockedHostname = (hostname: string): boolean =>
  blockedHostnames.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local");

const getNormalizedHostname = (url: URL): string =>
  url.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();

const reject = (reason: ImageProxyRejectionReason, message: string, statusCode = 400): never => {
  throw new ImageProxyError(message, reason, statusCode);
};

export const parseImageProxyQuery = (query: unknown): { sourceUrl: URL; width: number } => {
  const params = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const rawUrl = typeof params.url === "string" ? params.url : "";
  const rawWidth = typeof params.w === "string" ? params.w : "";
  const sourceUrl = (() => {
    try {
      return new URL(rawUrl);
    } catch {
      return reject("unsupported_protocol", "A valid image URL is required.");
    }
  })();

  if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
    reject("unsupported_protocol", "Only HTTP and HTTPS image URLs are supported.");
  }

  if (sourceUrl.username || sourceUrl.password) {
    reject("credentials_not_allowed", "Image URLs cannot include credentials.");
  }

  const width = Number.parseInt(rawWidth, 10);

  if (!allowedWidths.has(width) || String(width) !== rawWidth) {
    reject("source_unreachable", "Image width must be one of 96, 480, or 1200.");
  }

  return {
    sourceUrl,
    width
  };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, rejectPromise) => {
        timeout = setTimeout(() => rejectPromise(new Error("timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export const assertPublicImageUrl = async (
  url: URL,
  resolveHostname: ResolveHostname = lookup as ResolveHostname
): Promise<void> => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    reject("unsupported_protocol", "Only HTTP and HTTPS image URLs are supported.");
  }

  if (url.username || url.password) {
    reject("credentials_not_allowed", "Image URLs cannot include credentials.");
  }

  const hostname = getNormalizedHostname(url);

  if (!hostname || isBlockedHostname(hostname)) {
    reject("private_address", "Private image hosts are not allowed.");
  }

  const net = await import("node:net");

  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      reject("private_address", "Private image hosts are not allowed.");
    }

    return;
  }

  const resolvedAddresses = await (async () => {
    try {
      return await withTimeout(
        resolveHostname(hostname, {
          all: true,
          verbatim: true
        }),
        dnsTimeoutMs
      );
    } catch {
      return reject("dns_lookup_failed", "Image host could not be resolved.", 502);
    }
  })();

  if (
    resolvedAddresses.length === 0 ||
    resolvedAddresses.some((entry) => !isPublicIpAddress(entry.address))
  ) {
    reject("private_address", "Private image hosts are not allowed.");
  }
};

const getContentType = (response: Response): string => {
  const rawContentType = response.headers.get("content-type") ?? "";
  return rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
};

const sniffImageContentType = (buffer: Buffer): string | null => {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF") {
    return buffer.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : null;
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp" &&
    ["avif", "avis"].includes(buffer.subarray(8, 12).toString("ascii"))
  ) {
    return "image/avif";
  }

  return null;
};

const readImageBody = async (response: Response): Promise<Buffer> => {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    totalBytes += result.value.byteLength;

    if (totalBytes > maxImageBytes) {
      await reader.cancel();
      reject("image_too_large", "Image response exceeded the size limit.", 413);
    }

    chunks.push(result.value);
  }

  return Buffer.concat(chunks);
};

/*
 * Residual risk (accepted for Stage 1): the public-address check resolves DNS
 * separately from fetch(), so a rebinding attacker could answer the check with
 * a public IP and the fetch with a private one. On our serverless deployment
 * there is no reachable private network, IP-literal hosts are rejected
 * outright, and responses must pass image magic-byte sniffing, which bounds
 * the impact. Hardening path if deployment ever changes: pin the vetted
 * addresses by fetching through an undici Agent with a custom lookup.
 */
const fetchImageBytes = async (
  sourceUrl: URL,
  dependencies: Required<Pick<ImageProxyDependencies, "fetchImplementation" | "resolveHostname">>
): Promise<Buffer> => {
  const startedAt = Date.now();
  let currentUrl = sourceUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertPublicImageUrl(currentUrl, dependencies.resolveHostname);

    const remainingMs = Math.max(1, totalTimeoutMs - (Date.now() - startedAt));
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), remainingMs);
    const response = await (async () => {
      try {
        return await dependencies.fetchImplementation(currentUrl.toString(), {
          headers: {
            accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
            "user-agent": "LinkDishImageProxy/1.0"
          },
          redirect: "manual",
          signal: abortController.signal
        });
      } catch {
        return reject("source_unreachable", "Image source could not be reached.", 502);
      } finally {
        clearTimeout(timeout);
      }
    })();

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");

      if (!location) {
        return reject("source_unreachable", "Image redirect did not include a location.", 502);
      }

      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      reject("source_unreachable", "Image source returned an error.", 502);
    }

    const contentType = getContentType(response);

    if (!allowedContentTypes.has(contentType)) {
      reject("invalid_content_type", "Image source returned an unsupported content type.", 415);
    }

    const body = await readImageBody(response);
    const sniffedContentType = sniffImageContentType(body);

    if (!sniffedContentType || !allowedContentTypes.has(sniffedContentType)) {
      reject("invalid_image_bytes", "Image source returned invalid image bytes.", 415);
    }

    return body;
  }

  return reject("redirect_limit", "Image source redirected too many times.", 400);
};

const defaultLoadSharp = async (): Promise<SharpFactory> => {
  const sharpModule = (await import("sharp")) as { default?: SharpFactory } & SharpFactory;
  return sharpModule.default ?? sharpModule;
};

export const resizeImageToWebp = async (
  imageBytes: Buffer,
  width: number,
  loadSharp: () => Promise<SharpFactory> = defaultLoadSharp
): Promise<Buffer> => {
  const sharp = await loadSharp();

  return sharp(imageBytes, { failOn: "none" })
    .rotate()
    .resize({
      fit: "inside",
      width,
      withoutEnlargement: true
    })
    .webp({
      quality: 78
    })
    .toBuffer();
};

export const getProxiedImage = async (
  sourceUrl: URL,
  width: number,
  dependencies?: ImageProxyDependencies
): Promise<Buffer> => {
  const imageBytes = await fetchImageBytes(sourceUrl, {
    fetchImplementation: dependencies?.fetchImplementation ?? fetch,
    resolveHostname: dependencies?.resolveHostname ?? (lookup as ResolveHostname)
  });

  return resizeImageToWebp(imageBytes, width, dependencies?.loadSharp);
};

export const registerImageRoute = (app: FastifyInstance, dependencies?: ImageProxyDependencies) => {
  app.get("/image", async (request, reply) => {
    try {
      const { sourceUrl, width } = parseImageProxyQuery(request.query);
      const image = await getProxiedImage(sourceUrl, width, dependencies);

      return reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .type("image/webp")
        .send(image);
    } catch (error) {
      if (error instanceof ImageProxyError) {
        return reply.status(error.statusCode).send({
          message: error.message,
          reason: error.reason
        });
      }

      request.log.error(error);

      return reply.status(502).send({
        message: "Image could not be proxied.",
        reason: "source_unreachable"
      });
    }
  });
};
