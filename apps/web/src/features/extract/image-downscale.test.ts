import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PHOTO_DATA_URL_CHARS,
  MAX_PHOTO_EDGE,
  PHOTO_JPEG_QUALITY,
  PhotoPrepError,
  prepareRecipePhoto,
  scaleToFit
} from "./image-downscale";

/*
 * jsdom has no image decoding or canvas, so createImageBitmap and OffscreenCanvas are faked:
 * the fakes record the size drawn at and the encoding options, and return a small JPEG blob.
 */

interface CanvasCall {
  width: number;
  height: number;
  drawn: [number, number] | null;
  options: ImageEncodeOptions | undefined;
}

const canvasCalls: CanvasCall[] = [];
let blobSize = 40_000;

class FakeOffscreenCanvas {
  private readonly call: CanvasCall;

  public constructor(width: number, height: number) {
    this.call = { drawn: null, height, options: undefined, width };
    canvasCalls.push(this.call);
  }

  public getContext() {
    return {
      drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => {
        this.call.drawn = [width, height];
      },
      fillRect: () => undefined,
      fillStyle: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low"
    };
  }

  public convertToBlob(options?: ImageEncodeOptions): Promise<Blob> {
    this.call.options = options;
    return Promise.resolve(new Blob([new Uint8Array(blobSize)], { type: "image/jpeg" }));
  }
}

const photo = (name: string, type: string) => new File([new Uint8Array(64)], name, { type });

describe("scaleToFit", () => {
  it("shrinks the long edge to the limit and never upscales", () => {
    expect(scaleToFit(4032, 3024, 1600)).toEqual({ height: 1200, width: 1600 });
    expect(scaleToFit(3024, 4032, 1600)).toEqual({ height: 1600, width: 1200 });
    expect(scaleToFit(800, 600, 1600)).toEqual({ height: 600, width: 800 });
  });
});

describe("prepareRecipePhoto", () => {
  let bitmapSize = { height: 3024, width: 4032 };
  const close = vi.fn();

  beforeEach(() => {
    canvasCalls.length = 0;
    blobSize = 40_000;
    bitmapSize = { height: 3024, width: 4032 };
    close.mockReset();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.resolve({ ...bitmapSize, close }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downscales a phone photo to 1600px as a JPEG at quality 0.8", async () => {
    const prepared = await prepareRecipePhoto(photo("IMG_1.jpg", "image/jpeg"));

    expect(canvasCalls).toHaveLength(1);
    expect(canvasCalls[0]).toMatchObject({
      drawn: [MAX_PHOTO_EDGE, 1200],
      height: 1200,
      options: { quality: PHOTO_JPEG_QUALITY, type: "image/jpeg" },
      width: MAX_PHOTO_EDGE
    });
    expect(prepared.mimeType).toBe("image/jpeg");
    expect(prepared.dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    expect(prepared.dataUrl.length).toBeLessThan(MAX_PHOTO_DATA_URL_CHARS);
    expect(prepared).toMatchObject({ height: 1200, width: 1600 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("re-encodes smaller when a photo is unusually detailed", async () => {
    blobSize = 1_500_000;
    const first = canvasCalls.length;

    await expect(prepareRecipePhoto(photo("IMG_2.png", "image/png"))).rejects.toMatchObject({
      code: "too_large"
    });

    const calls = canvasCalls.slice(first);
    expect(calls.map((call) => [call.width, call.options?.quality])).toEqual([
      [1600, 0.8],
      [1200, 0.7]
    ]);
  });

  it("explains HEIC photos the browser can't open", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new DOMException("unsupported", "InvalidStateError")))
    );
    // jsdom has no object URLs.
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
    // The <img> fallback can't decode it either.
    vi.spyOn(window.HTMLImageElement.prototype, "src", "set").mockImplementation(function (
      this: HTMLImageElement
    ) {
      setTimeout(() => {
        this.onerror?.(new Event("error"));
      }, 0);
    });

    const error = await prepareRecipePhoto(photo("IMG_0042.HEIC", "image/heic")).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(PhotoPrepError);
    expect(error).toMatchObject({ code: "heic_unsupported" });
    expect((error as Error).message).toMatch(/HEIC/u);
  });

  it("refuses files that aren't pictures", async () => {
    await expect(prepareRecipePhoto(photo("notes.pdf", "application/pdf"))).rejects.toMatchObject({
      code: "not_image"
    });
    expect(canvasCalls).toHaveLength(0);
  });
});
