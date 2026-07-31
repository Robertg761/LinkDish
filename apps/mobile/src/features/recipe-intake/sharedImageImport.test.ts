import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_SHARED_IMAGE_DATA_URL_LENGTH, prepareSharedImageImport } from "./sharedImageImport";

const fileSystemMocks = vi.hoisted(() => ({
  base64: vi.fn(),
  delete: vi.fn()
}));
const imageManipulatorMocks = vi.hoisted(() => ({
  manipulateAsync: vi.fn()
}));

vi.mock("expo-file-system", () => ({
  File: class {
    exists = true;

    constructor(readonly uri: string) {}

    base64 = fileSystemMocks.base64;
    delete = fileSystemMocks.delete;
  }
}));

vi.mock("expo-image-manipulator", () => ({
  manipulateAsync: imageManipulatorMocks.manipulateAsync,
  SaveFormat: {
    JPEG: "jpeg"
  }
}));

describe("prepareSharedImageImport", () => {
  beforeEach(() => {
    fileSystemMocks.base64.mockReset();
    fileSystemMocks.base64.mockResolvedValue("source-base64");
    fileSystemMocks.delete.mockReset();
    imageManipulatorMocks.manipulateAsync.mockReset();
  });

  it("reads a content URI and returns a normalized JPEG payload", async () => {
    imageManipulatorMocks.manipulateAsync.mockResolvedValue({
      base64: "abc123",
      height: 900,
      uri: "file:///cache/result.jpg",
      width: 1200
    });

    await expect(prepareSharedImageImport("content://photos/recipe", "image/png")).resolves.toEqual(
      {
        dataUrl: "data:image/jpeg;base64,abc123",
        mimeType: "image/jpeg"
      }
    );
    expect(fileSystemMocks.base64).toHaveBeenCalledTimes(1);
    expect(imageManipulatorMocks.manipulateAsync).toHaveBeenCalledWith(
      "data:image/png;base64,source-base64",
      [],
      expect.objectContaining({ format: "jpeg" })
    );
    expect(fileSystemMocks.delete).toHaveBeenCalledTimes(1);
  });

  it("recompresses oversized output before accepting it", async () => {
    imageManipulatorMocks.manipulateAsync
      .mockResolvedValueOnce({
        base64: "a".repeat(MAX_SHARED_IMAGE_DATA_URL_LENGTH),
        height: 3200,
        uri: "file:///cache/large.jpg",
        width: 2400
      })
      .mockResolvedValueOnce({
        base64: "small",
        height: 2400,
        uri: "file:///cache/smaller.jpg",
        width: 1800
      });

    await expect(prepareSharedImageImport("content://photos/large")).resolves.toEqual({
      dataUrl: "data:image/jpeg;base64,small",
      mimeType: "image/jpeg"
    });
    expect(imageManipulatorMocks.manipulateAsync).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [{ resize: { width: 1800 } }],
      expect.objectContaining({ compress: 0.62 })
    );
  });
});
