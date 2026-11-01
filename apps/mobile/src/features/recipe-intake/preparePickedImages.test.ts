import { MAX_IMAGE_DATA_URL_CHARS, MAX_IMAGE_EXTRACT_PAYLOAD_CHARS } from "@linkdish/api-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { preparePickedImages } from "./preparePickedImages";

const mocks = vi.hoisted(() => ({ manipulate: vi.fn(), deleteFile: vi.fn() }));
vi.mock("expo-image-manipulator", () => ({
  manipulateAsync: mocks.manipulate,
  SaveFormat: { JPEG: "jpeg" }
}));
vi.mock("expo-file-system", () => ({
  File: class {
    exists = true;
    delete = mocks.deleteFile;
  }
}));

const portrait = { uri: "file:///cache/photo.heic", width: 6048, height: 8064 };
const output = (base64 = "encoded") => ({
  uri: "file:///cache/output.jpg",
  base64,
  width: 1800,
  height: 2400
});

describe("preparePickedImages", () => {
  beforeEach(() => {
    mocks.manipulate.mockReset().mockResolvedValue(output());
    mocks.deleteFile.mockReset();
  });

  it("resizes a high-resolution portrait and converts it to JPEG before upload", async () => {
    expect(await preparePickedImages([portrait])).toEqual([
      { dataUrl: "data:image/jpeg;base64,encoded", mimeType: "image/jpeg" }
    ]);
    expect(mocks.manipulate).toHaveBeenCalledWith(portrait.uri, [{ resize: { height: 2400 } }], {
      base64: true,
      compress: 0.8,
      format: "jpeg"
    });
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
  });

  it("bounds landscape photos by width and does not upscale small screenshots", async () => {
    await preparePickedImages([
      { ...portrait, width: 8064, height: 6048 },
      { ...portrait, width: 600, height: 800 }
    ]);
    expect(mocks.manipulate.mock.calls[0]?.[1]).toEqual([{ resize: { width: 2400 } }]);
    expect(mocks.manipulate.mock.calls[1]?.[1]).toEqual([]);
  });

  it("retries oversized output with a smaller image rather than rejecting a large original", async () => {
    mocks.manipulate.mockResolvedValueOnce(output("a".repeat(MAX_IMAGE_DATA_URL_CHARS)));
    expect(await preparePickedImages([portrait])).toHaveLength(1);
    expect(mocks.manipulate).toHaveBeenNthCalledWith(
      2,
      portrait.uri,
      [{ resize: { height: 1800 } }],
      { base64: true, compress: 0.65, format: "jpeg" }
    );
    expect(mocks.deleteFile).toHaveBeenCalledTimes(2);
  });

  it("budgets all four selected pages together, preserving their order", async () => {
    const pages = [1, 2, 3, 4].map((i) => ({ ...portrait, uri: `file:///page-${i}.png` }));
    for (let i = 1; i <= 4; i++) {
      mocks.manipulate
        .mockResolvedValueOnce(output("a".repeat(2_100_000)))
        .mockResolvedValueOnce(output(String(i).repeat(900_000)));
    }
    const images = await preparePickedImages(pages);
    expect(images).toHaveLength(4);
    expect(images.map((i) => i.dataUrl.slice(-1))).toEqual(["1", "2", "3", "4"]);
    expect(
      JSON.stringify({
        images,
        attempt: "fallback",
        sourceUrl: "https://linkdish.app/image-imports/test"
      }).length
    ).toBeLessThan(MAX_IMAGE_EXTRACT_PAYLOAD_CHARS);
    expect(JSON.stringify({ images }).length).toBeLessThan(4_500_000);
    expect(mocks.manipulate).toHaveBeenCalledTimes(8);
  });

  it("rejects the entire selection if a page still cannot fit after all retries", async () => {
    mocks.manipulate.mockResolvedValue(output("a".repeat(MAX_IMAGE_DATA_URL_CHARS)));
    await expect(preparePickedImages([portrait])).rejects.toThrow("upload limit");
    expect(mocks.manipulate).toHaveBeenCalledTimes(3);
    expect(mocks.deleteFile).toHaveBeenCalledTimes(3);
  });

  it("does not delete the source image if the native result reuses its URI", async () => {
    mocks.manipulate.mockResolvedValue({ ...output(), uri: portrait.uri });
    await preparePickedImages([portrait]);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });
});
