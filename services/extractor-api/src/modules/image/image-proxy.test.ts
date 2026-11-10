import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  assertPublicImageUrl,
  buildProxiedImageCacheHeaders,
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
      }) as unknown
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

describe("buildProxiedImageCacheHeaders (follows the publisher's caching directions)", () => {
  it("keeps the previous policy when the publisher says nothing", () => {
    expect(buildProxiedImageCacheHeaders(null)).toEqual({
      "cache-control": "public, max-age=31536000, immutable",
      "cdn-cache-control": "public, s-maxage=86400, stale-while-revalidate=604800"
    });
  });

  it("keeps no copy anywhere when the publisher says no-store", () => {
    expect(buildProxiedImageCacheHeaders("public, no-store")).toEqual({
      "cache-control": "no-store",
      "cdn-cache-control": "no-store"
    });
  });

  it("keeps no shared CDN copy of a private or no-cache image", () => {
    for (const value of ["private, max-age=600", "no-cache"]) {
      expect(buildProxiedImageCacheHeaders(value)).toEqual({
        "cache-control": "private, no-cache",
        "cdn-cache-control": "no-store"
      });
    }
  });

  it("never keeps a copy longer than the publisher's max-age", () => {
    expect(buildProxiedImageCacheHeaders("public, max-age=3600")).toEqual({
      "cache-control": "public, max-age=3600",
      "cdn-cache-control": "public, s-maxage=3600"
    });
    expect(buildProxiedImageCacheHeaders("max-age=0")).toEqual({
      "cache-control": "public, max-age=0",
      "cdn-cache-control": "no-store"
    });
  });

  it("uses s-maxage for the CDN, capped at a day, and only the publisher's own stale window", () => {
    expect(
      buildProxiedImageCacheHeaders("max-age=31536000, s-maxage=604800, stale-while-revalidate=60")
    ).toEqual({
      "cache-control": "public, max-age=31536000",
      "cdn-cache-control": "public, s-maxage=86400, stale-while-revalidate=60"
    });
    expect(buildProxiedImageCacheHeaders("public, max-age=31536000, immutable")).toEqual({
      "cache-control": "public, max-age=31536000, immutable",
      "cdn-cache-control": "public, s-maxage=86400"
    });
  });
});

describe("registerImageRoute with publisher cache directions", () => {
  it("sends no-store on when the publisher's image says no-store", async () => {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(pngSignature, {
        headers: { "cache-control": "no-store", "content-type": "image/png" },
        status: 200
      })
    );
    const pipeline = {
      resize: () => pipeline,
      rotate: () => pipeline,
      toBuffer: () => Promise.resolve(Buffer.from("webp-bytes")),
      webp: () => pipeline
    };
    const app = Fastify();
    registerImageRoute(app, {
      fetchImplementation,
      loadSharp: () => Promise.resolve(() => pipeline),
      resolveHostname: resolverFor({})
    });

    const response = await app.inject({
      method: "GET",
      url: "/image?url=https%3A%2F%2Fimages.example.com%2Frecipe.png&w=480"
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["cdn-cache-control"]).toBe("no-store");
  });
});
