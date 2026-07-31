import { describe, expect, it } from "vitest";

import {
  canSaveAnotherRecipe,
  getRemainingImports,
  normalizeBillingState,
  parseBillingState
} from "./store";

describe("billing store helpers", () => {
  it("starts a fresh usage period when the stored month is stale", () => {
    const state = normalizeBillingState(
      {
        tier: "plus",
        usage: {
          imports: 100,
          periodKey: "2026-03",
          strongExtractions: 100
        },
        usageAccountingVersion: 3
      },
      "2026-04"
    );

    expect(state).toEqual({
      tier: "plus",
      usage: {
        imports: 0,
        periodKey: "2026-04",
        strongExtractions: 0
      },
      usageAccountingVersion: 3
    });
  });

  it("keeps free usage across calendar months", () => {
    const state = normalizeBillingState(
      {
        tier: "free",
        usage: {
          imports: 2,
          periodKey: "2026-03",
          strongExtractions: 2
        },
        usageAccountingVersion: 3
      },
      "2026-04"
    );

    expect(state.usage).toEqual({
      imports: 2,
      periodKey: "2026-03",
      strongExtractions: 2
    });
    expect(getRemainingImports(state)).toBe(1);
  });

  it("starts fresh when stored usage was counted with old accounting rules", () => {
    const state = normalizeBillingState(
      {
        tier: "free",
        usage: {
          imports: 5,
          periodKey: "2026-04",
          strongExtractions: 1
        }
      },
      "2026-04"
    );

    expect(state.usage).toEqual({
      imports: 0,
      periodKey: "2026-04",
      strongExtractions: 0
    });
    expect(state.usageAccountingVersion).toBe(3);
  });

  it("falls back to the free tier for invalid stored payloads", () => {
    expect(parseBillingState("not json", "2026-04").tier).toBe("free");
    expect(parseBillingState('{"tier":"team"}', "2026-04").tier).toBe("free");
  });

  it("preserves family billing state from local previews or restored storage", () => {
    expect(parseBillingState('{"tier":"family"}', "2026-04").tier).toBe("family");
  });

  it("limits new free saved recipes but allows existing saved recipe updates", () => {
    expect(canSaveAnotherRecipe("free", 14, false)).toBe(true);
    expect(canSaveAnotherRecipe("free", 15, false)).toBe(false);
    expect(canSaveAnotherRecipe("free", 16, true)).toBe(true);
    expect(canSaveAnotherRecipe("plus", 100, false)).toBe(true);
    expect(canSaveAnotherRecipe("family", 100, false)).toBe(true);
  });
});
