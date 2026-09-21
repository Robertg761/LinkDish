import { load } from "cheerio";

import type { HtmlSourceDocument, InternalFetchFailureKind } from "../types.js";

export const browserLikeHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
} as const;

const defaultBlockedPatterns = [
  /captcha/i,
  /attention required/i,
  /cf-chl/i,
  /cloudflare/i,
  /access denied/i,
  /are you human/i,
  /verify you are human/i,
  /safeguarding your website/i,
  /bigscoots/i,
  /automated queries/i,
  /unusual traffic/i,
  /security check/i
] as const;

const notFoundTitlePatterns = [
  /\b404\b/i,
  /\bpage not found\b/i,
  /\bnot found\b/i,
  /\bcontent unavailable\b/i
] as const;

const redirectHintPatterns = [
  /\bthis recipe has moved\b/i,
  /\bpage not found\b/i,
  /\bnot found\b/i
] as const;

/*
 * The extract path fetches attacker-supplied URLs, so response bodies are
 * streamed with a hard byte cap (mirroring the image proxy's readImageBody)
 * instead of being buffered with response.text(). Without this a URL that
 * streams hundreds of megabytes inside the fetch timeout window is buffered in
 * full and then re-parsed several times downstream, which OOMs a
 * memory-bounded serverless function.
 */
export class ResponseBodyTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`Response body exceeded the ${maxBytes} byte limit.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

const htmlLikeContentTypes = new Set([
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/plain",
  "text/xml"
]);

export const getContentTypeEssence = (value: string | null | undefined): string =>
  (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

export const isHtmlLikeContentType = (value: string | null | undefined): boolean => {
  const essence = getContentTypeEssence(value);

  /* Servers that omit content-type are common enough that we keep reading them. */
  return essence === "" || htmlLikeContentTypes.has(essence);
};

const getDeclaredContentLength = (response: Response): number | null => {
  const rawValue = response.headers?.get?.("content-length");

  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : null;
};

export const readLimitedResponseText = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declaredContentLength = getDeclaredContentLength(response);

  if (declaredContentLength !== null && declaredContentLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes);
  }

  const body = response.body as ReadableStream<Uint8Array> | null | undefined;

  if (!body || typeof body.getReader !== "function") {
    /* Mocked or already-buffered responses still get the same cap. */
    const text = await response.text();

    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
    }

    return text;
  }

  const reader = body.getReader();
  /* Matches Response.text(), which always decodes as UTF-8. */
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let totalBytes = 0;

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      if (!result.value) {
        continue;
      }

      totalBytes += result.value.byteLength;

      if (totalBytes > maxBytes) {
        throw new ResponseBodyTooLargeError(maxBytes);
      }

      text += decoder.decode(result.value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return text + decoder.decode();
};

export const sleep = async (durationMs: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

export const createTimeoutSignal = (
  timeoutMs: number
): {
  signal: AbortSignal;
  cleanup: () => void;
} => {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error(`timeout:${timeoutMs}`)),
    timeoutMs
  );

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId)
  };
};

export const detectBlockedSignals = ({
  html,
  statusCode,
  extraPatterns = []
}: {
  html: string;
  statusCode: number;
  extraPatterns?: RegExp[];
}): string[] => {
  const blockedSignals: string[] = [];
  const normalizedHtml = html.toLowerCase();

  if (statusCode === 403 || statusCode === 429) {
    blockedSignals.push(`status:${statusCode}`);
  }

  for (const pattern of [...defaultBlockedPatterns, ...extraPatterns]) {
    if (pattern.test(normalizedHtml)) {
      blockedSignals.push(pattern.source);
    }
  }

  if (/<title>\s*just a moment/i.test(normalizedHtml)) {
    blockedSignals.push("challenge-title");
  }

  return [...new Set(blockedSignals)];
};

export const classifyFetchStatusCode = (statusCode: number): InternalFetchFailureKind | null => {
  if ([401, 402, 403, 429, 451].includes(statusCode)) {
    return "blocked";
  }

  if ([404, 410].includes(statusCode)) {
    return "not_found";
  }

  if (statusCode >= 500) {
    return "unreachable";
  }

  return null;
};

export const looksLikeShellHtml = (html: string): boolean => {
  const $ = load(html);
  const visibleText = $("body").text().replace(/\s+/g, " ").trim();
  const rootMarkerCount = $("#__next, #root, #app, [data-reactroot], [id*='app']").length;
  const scriptCount = $("script").length;

  return visibleText.length < 180 && rootMarkerCount > 0 && scriptCount > 8;
};

export const looksLikeThinHtml = (html: string): boolean => {
  const $ = load(html);
  const visibleText = $("body").text().replace(/\s+/g, " ").trim();

  return visibleText.length < 100 && html.replace(/\s+/g, "").length < 1500;
};

export const looksLikeNotFoundTitle = (title: string | null): boolean =>
  title ? notFoundTitlePatterns.some((pattern) => pattern.test(title)) : false;

export const looksLikeNotFoundHtml = (html: string): boolean => {
  const $ = load(html);
  const title = $("title").text().trim();
  const h1 = $("h1").first().text().trim();

  return looksLikeNotFoundTitle(title) || looksLikeNotFoundTitle(h1);
};

const tokenizeUrlPath = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 && !["recipe", "recipes", "article", "blog", "videos"].includes(token)
    );

export const looksLikeUnrelatedRedirect = ({
  requestedUrl,
  finalUrl,
  title,
  html
}: {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  html: string;
}): boolean => {
  if (requestedUrl === finalUrl) {
    return false;
  }

  if (redirectHintPatterns.some((pattern) => pattern.test(title ?? "") || pattern.test(html))) {
    return true;
  }

  const requested = new URL(requestedUrl);
  const final = new URL(finalUrl);

  if (requested.hostname !== final.hostname) {
    return true;
  }

  const requestedTokens = tokenizeUrlPath(requested.pathname);
  const finalTokens = tokenizeUrlPath(final.pathname);

  if (requestedTokens.length === 0 || finalTokens.length === 0) {
    return false;
  }

  const overlap = requestedTokens.filter((token) => finalTokens.includes(token));

  return overlap.length === 0;
};

export const buildHtmlSourceDocument = ({
  url,
  finalUrl,
  html,
  contentType,
  blockedSignals,
  statusCode
}: {
  url: string;
  finalUrl: string;
  html: string;
  contentType: string | null;
  blockedSignals: string[];
  statusCode: number;
}): HtmlSourceDocument => {
  const $ = load(html);
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $('meta[name="twitter:title"]').attr("content")?.trim() ||
    $("title").text().trim() ||
    null;
  const description =
    $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim() ||
    null;

  return {
    kind: "html",
    url,
    finalUrl,
    html,
    contentType,
    title,
    description,
    blockedSignals,
    statusCode
  };
};
