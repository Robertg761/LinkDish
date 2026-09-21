import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isStorageWritable, safeGetItem, safeRemoveItem, safeSetItem } from "./safe-storage";

describe("safe-storage", () => {
  const activeSpies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    activeSpies.splice(0).forEach((spy) => {
      spy.mockRestore();
    });
  });

  it("reads and writes local storage", () => {
    expect(safeSetItem("k", "v")).toBe(true);
    expect(safeGetItem("k")).toBe("v");
    expect(safeRemoveItem("k")).toBe(true);
    expect(safeGetItem("k")).toBeNull();
    expect(isStorageWritable()).toBe(true);
  });

  it("reads and writes session storage", () => {
    expect(safeSetItem("k", "v", "session")).toBe(true);
    expect(safeGetItem("k", "session")).toBe("v");
    expect(safeGetItem("k", "local")).toBeNull();
  });

  it("reports failure instead of throwing when writes are blocked", () => {
    activeSpies.push(
      vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      })
    );

    expect(safeSetItem("k", "v")).toBe(false);
    expect(isStorageWritable()).toBe(false);
  });

  it("returns null instead of throwing when reads are blocked", () => {
    activeSpies.push(
      vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
        throw new DOMException("Access denied.", "SecurityError");
      })
    );

    expect(safeGetItem("k")).toBeNull();
  });

  it("returns false instead of throwing when removals are blocked", () => {
    activeSpies.push(
      vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => {
        throw new DOMException("Access denied.", "SecurityError");
      })
    );

    expect(safeRemoveItem("k")).toBe(false);
  });
});
