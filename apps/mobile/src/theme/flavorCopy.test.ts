import { describe, expect, it } from "vitest";

import {
  EMPTY_LIBRARY_LINES,
  EXTRACTION_ERROR_LINES,
  selectFlavorCopyLine
} from "./flavorCopy";

describe("flavorCopy", () => {
  it("selects extraction error copy from the exported list", () => {
    expect(EXTRACTION_ERROR_LINES).toContain(selectFlavorCopyLine(EXTRACTION_ERROR_LINES, 0.4));
  });

  it("selects empty library copy from the exported list", () => {
    expect(EMPTY_LIBRARY_LINES).toContain(selectFlavorCopyLine(EMPTY_LIBRARY_LINES, 0.8));
  });
});
