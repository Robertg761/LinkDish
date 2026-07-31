import { describe, expect, it } from "vitest";

import {
  consumePendingImageImport,
  createPendingImageImport,
  getPendingImageImport
} from "./pendingImageImports";

describe("pendingImageImports", () => {
  it("consumes pending image imports so base64 data is not retained", () => {
    const pendingImport = createPendingImageImport([
      {
        dataUrl: "data:image/jpeg;base64,abc123",
        mimeType: "image/jpeg"
      }
    ]);

    expect(getPendingImageImport(pendingImport.id)).toBe(pendingImport);
    expect(consumePendingImageImport(pendingImport.id)).toBe(pendingImport);
    expect(getPendingImageImport(pendingImport.id)).toBeUndefined();
  });
});
