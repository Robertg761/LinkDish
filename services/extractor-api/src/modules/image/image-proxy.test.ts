import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  assertPublicImageUrl,
  getProxiedImage,
  ImageProxyError,
  parseImageProxyQuery,
  registerImageRoute
} from "./image-proxy";

import type { ImageProxyDependencies } from "./image-proxy";
import type { ResolveHostname } from "../extract/source-url-safety";

const resolverFor =
  (
    entriesByHostname: Record<string, Array<{ address: string; family: number }>>
  ): ResolveHostname =>
  (hostname) =>
    Promise.resolve(entriesByHostname[hostname] ?? [{ address: "93.184.216.34", family: 4 }]);

describe("parseImageProxyQuery", () => {
  it("accepts only supported resize widths", () => {
    for (const width of ["96", "480", "1200"]) {
      expect(
        parseImageProxyQuery({
          url: "https://images.example.com/recipe.jpg",
          w: width
        })
      ).toMatchObject({
        width: Number(width)
      });
    }

    expect(() =>
      parseImageProxyQuery({
        url: "https://images.example.com/recipe.jpg",
        w: "320"
      })
    ).toThrow(ImageProxyError);
  });

  it("reports an unsupported width with an accurate reason", () => {
    expect(() =>
      parseImageProxyQuery({
        url: "https://images.example.com/recipe.jpg",
        w: "320"
      })
    ).toThrowError(
      expect.objectContaining({
        reason: "invalid_width"
      }) as unknown as Error
    );
  });

  it("rejects credentials and non-http urls", () => {
    expect(() =>
      parseImageProxyQuery({
        url: "https://user:pass@images.example.com/recipe.jpg",
        w: "480"
      })
    ).toThrow(ImageProxyError);

    expect(() =>
      parseImageProxyQuery({
        url: "file:///etc/passwd",
        w: "480"
      })
    ).toThrow(ImageProxyError);
  });
});

describe("assertPublicImageUrl", () => {
  it("rejects hostnames that resolve to private addresses", async () => {
    await expect(
      assertPublicImageUrl(
        new URL("https://images.example.com/recipe.jpg"),
        resolverFor({
          "images.example.com": [{ address: "10.0.0.4", family: 4 }]
        })
      )
    ).rejects.toMatchObject({
      reason: "private_address"
    });
  });
});

describe("getProxiedImage", () => {
  it("re-checks redirected hosts before following them", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        headers: {
          location: "http://metadata.example/latest/meta-data"
        },
        status: 302
      })
    );

    await expect(
      getProxiedImage(new URL("https://images.example.com/recipe.jpg"), 480, {
        fetchImplementation,
        resolveHostname: resolverFor({
          "images.example.com": [{ address: "93.184.216.34", family: 4 }],
          "metadata.example": [{ address: "169.254.169.254", family: 4 }]
        })
      })
    ).rejects.toMatchObject({
      reason: "private_address"
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("enforces the redirect cap", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation((url) => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      return Promise.resolve(
        new Response(null, {
          headers: {
            location: `${requestUrl.replace(/\/$/u, "")}/next`
          },
          status: 302
        })
      );
    });

    await expect(
      getProxiedImage(new URL("https://images.example.com/recipe.jpg"), 480, {
        fetchImplementation,
        resolveHostname: resolverFor({
          "images.example.com": [{ address: "93.184.216.34", family: 4 }]
        })
      })
    ).rejects.toMatchObject({
      reason: "redirect_limit"
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });
});

describe("registerImageRoute", () => {
  it("lets browsers keep the WebP and has the shared CDN copy revalidated daily", async () => {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(pngSignature, { headers: { "content-type": "image/png" }, status: 200 })
      );
    const pipeline = {
      resize: () => pipeline,
      rotate: () => pipeline,
      toBuffer: () => Promise.resolve(Buffer.from("webp-bytes")),
      webp: () => pipeline
    };
    const loadSharp: NonNullable<ImageProxyDependencies["loadSharp"]> = () =>
      Promise.resolve(() => pipeline);
    const app = Fastify();
    registerImageRoute(app, {
      fetchImplementation,
      loadSharp,
      resolveHostname: resolverFor({})
    });

    const response = await app.inject({
      method: "GET",
      url: "/image?url=https%3A%2F%2Fimages.example.com%2Frecipe.png&w=480"
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    // The cache key is only the source URL and width, and sites replace images at the same URL.
    expect(response.headers["cdn-cache-control"]).toBe(
      "public, s-maxage=86400, stale-while-revalidate=604800"
    );
    expect(response.body).toBe("webp-bytes");
  });
});
