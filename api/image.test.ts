import { afterEach, describe, expect, it, vi } from "vitest";

const imageMocks = vi.hoisted(() => {
  class MockImageProxyError extends Error {
    public constructor(
      message: string,
      public readonly reason: string,
      public readonly statusCode: number
    ) {
      super(message);
      this.name = "ImageProxyError";
    }
  }

  return {
    getProxiedImage: vi.fn(),
    ImageProxyError: MockImageProxyError,
    parseImageProxyQuery: vi.fn()
  };
});

vi.mock("../services/extractor-api/src/modules/image/image-proxy.js", () => ({
  getProxiedImage: imageMocks.getProxiedImage,
  ImageProxyError: imageMocks.ImageProxyError,
  parseImageProxyQuery: imageMocks.parseImageProxyQuery
}));

const request = (
  url = "https://api.linkdish.ca/image?url=https%3A%2F%2Fimg.test%2Ffood.jpg&w=480"
) =>
  new Request(url, {
    method: "GET",
    headers: {
      origin: "https://app.linkdish.ca"
    }
  });

afterEach(() => {
  vi.clearAllMocks();
});

describe("Vercel image adapter", () => {
  it("validates query params through the shared image proxy parser", async () => {
    imageMocks.parseImageProxyQuery.mockImplementation(() => {
      throw new imageMocks.ImageProxyError(
        "Image width must be one of 96, 480, or 1200.",
        "source_unreachable",
        400
      );
    });
    const imageApi = await import("./image.js");

    const response = await imageApi.GET(request("https://api.linkdish.ca/image?w=320"));

    expect(response.status).toBe(400);
    expect(imageMocks.parseImageProxyQuery).toHaveBeenCalledWith({
      w: "320"
    });
    await expect(response.json()).resolves.toEqual({
      message: "Image width must be one of 96, 480, or 1200.",
      reason: "source_unreachable"
    });
  });

  it("returns WebP bytes with the immutable image cache policy", async () => {
    imageMocks.parseImageProxyQuery.mockReturnValue({
      sourceUrl: new URL("https://img.test/food.jpg"),
      width: 480
    });
    imageMocks.getProxiedImage.mockResolvedValue(Buffer.from("webp-bytes"));
    const imageApi = await import("./image.js");

    const response = await imageApi.GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.linkdish.ca");
    expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe("webp-bytes");
    expect(imageMocks.getProxiedImage).toHaveBeenCalledWith(
      new URL("https://img.test/food.jpg"),
      480
    );
  });

  it("maps shared ImageProxyError statuses and reasons", async () => {
    imageMocks.parseImageProxyQuery.mockReturnValue({
      sourceUrl: new URL("https://img.test/food.jpg"),
      width: 480
    });
    imageMocks.getProxiedImage.mockRejectedValue(
      new imageMocks.ImageProxyError(
        "Image source returned an unsupported content type.",
        "invalid_content_type",
        415
      )
    );
    const imageApi = await import("./image.js");

    const response = await imageApi.GET(request());

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      message: "Image source returned an unsupported content type.",
      reason: "invalid_content_type"
    });
  });
});
