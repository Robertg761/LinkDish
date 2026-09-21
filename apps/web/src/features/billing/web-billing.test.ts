import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canStartWebImport,
  getRemainingImports,
  spendWebImport,
  spendWebStrongExtraction
} from "./web-billing";

describe("web-billing usage writes", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a spent import in storage", () => {
    expect(getRemainingImports("free")).toBe(3);
    expect(spendWebImport("free").allowed).toBe(true);
    expect(getRemainingImports("free")).toBe(2);
  });

  it("does not throw when localStorage refuses writes", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });

    expect(() => spendWebImport("free")).not.toThrow();
    expect(() => spendWebStrongExtraction("free")).not.toThrow();
    expect(canStartWebImport("free").allowed).toBe(true);
  });
});
