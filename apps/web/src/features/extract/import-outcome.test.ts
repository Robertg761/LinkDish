import { afterEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";

import {
  describeImportError,
  describeImportFailure,
  describeNeedsRetry,
  getFriendlyImportNotes,
  getImportErrorAnalytics
} from "./import-outcome";

import type { ExtractRecipeFailure } from "@linkdish/api-contracts";

const failure = (
  reason: ExtractRecipeFailure["reason"],
  extra: Partial<ExtractRecipeFailure> = {}
): ExtractRecipeFailure => ({
  reason,
  status: "failure",
  userMessage: "Server words.",
  ...extra
});

const freeQuota = {
  limit: 3,
  meteringMode: "free_lifetime" as const,
  monthlyLimit: null,
  remaining: 0,
  remainingThisMonth: null,
  resetsAt: null
};

const url = { kind: "url" as const, plan: "free" as const };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeImportFailure", () => {
  it("never treats the AI provider running out of capacity as the person's plan limit", () => {
    const problem = describeImportFailure(
      failure("quota_exceeded", {
        recovery: { allowFallback: false, retryable: true, suggestedAction: "try_again_later" }
      }),
      { kind: "url", plan: "plus" }
    );

    expect(problem.isPlanLimit).toBe(false);
    expect(problem.kind).toBe("capacity");
    expect(problem.actions[0]).toBe("retry");
    expect(problem.actions).not.toContain("see_plans");
    expect(problem.message).toMatch(/isn't your plan limit/u);
  });

  it("offers plans only for a real plan limit (with the allowance attached)", () => {
    const limited = describeImportFailure(failure("plan_limit", { quota: freeQuota }), url);
    expect(limited).toMatchObject({ isPlanLimit: true, kind: "plan_limit" });
    expect(limited.actions).toEqual(["see_plans"]);
    expect(limited.detail).toBe("0 of 3 free imports left");

    const unchecked = describeImportFailure(failure("plan_limit"), url);
    expect(unchecked).toMatchObject({ isPlanLimit: false, kind: "allowance_check" });
    expect(unchecked.actions).toEqual(["retry"]);
  });

  it("maps each reason to specific next steps", () => {
    expect(describeImportFailure(failure("source_blocked"), url).actions).toEqual([
      "paste_text",
      "scan_photo",
      "another_link"
    ]);
    expect(describeImportFailure(failure("source_unreachable"), url).actions).toEqual([
      "retry",
      "paste_text",
      "another_link"
    ]);
    expect(describeImportFailure(failure("timeout"), url).actions[0]).toBe("retry");
    expect(describeImportFailure(failure("unsupported_source"), url).actions).toEqual([
      "paste_text",
      "scan_photo",
      "another_link"
    ]);
    expect(describeImportFailure(failure("fallback_failed"), url).actions).toEqual([
      "paste_text",
      "scan_photo",
      "another_link"
    ]);
  });

  it("follows the server's suggested recovery", () => {
    const retryFirst = describeImportFailure(
      failure("parse_failed", {
        recovery: { allowFallback: false, retryable: true, suggestedAction: "retry_primary" }
      }),
      url
    );
    expect(retryFirst.actions[0]).toBe("retry");

    const aiFirst = describeImportFailure(
      failure("parse_failed", {
        recovery: { allowFallback: true, retryable: true, suggestedAction: "retry_fallback" }
      }),
      url
    );
    expect(aiFirst.actions[0]).toBe("retry_ai");

    const giveUpOnLink = describeImportFailure(
      failure("source_unreachable", {
        recovery: { allowFallback: false, retryable: false, suggestedAction: "try_another_url" }
      }),
      url
    );
    expect(giveUpOnLink.actions).not.toContain("retry");
    expect(giveUpOnLink.actions).toContain("another_link");
  });

  it("talks about text and photos in their own terms", () => {
    const text = describeImportFailure(failure("parse_failed"), { kind: "text", plan: "free" });
    expect(text.title).toBe("No recipe in that text");
    expect(text.actions).toContain("edit_text");

    const photos = describeImportFailure(failure("parse_failed"), { kind: "images", plan: "free" });
    expect(photos.title).toBe("No recipe in those photos");
    expect(photos.actions).toContain("change_photos");
  });
});

describe("describeImportError", () => {
  it("explains transport failures without upselling", () => {
    const network = describeImportError(
      new ExtractorApiError("x", 0, undefined, { kind: "network" }),
      url
    );
    expect(network).toMatchObject({ isPlanLimit: false, kind: "network" });

    const timeout = describeImportError(
      new ExtractorApiError("x", 0, undefined, { kind: "timeout" }),
      url
    );
    expect(timeout.kind).toBe("timeout");
    expect(timeout.actions[0]).toBe("retry");

    const rateLimited = describeImportError(new ExtractorApiError("x", 429), url);
    expect(rateLimited).toMatchObject({ isPlanLimit: false, kind: "rate_limited" });

    const tooLarge = describeImportError(new ExtractorApiError("x", 413), {
      kind: "images",
      plan: "free"
    });
    expect(tooLarge.actions).toEqual(["change_photos"]);
  });

  it("knows when the browser is offline", () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    expect(describeImportError(new TypeError("Failed to fetch"), url).kind).toBe("offline");
  });

  it("keeps the analytics vocabulary", () => {
    expect(getImportErrorAnalytics(new ExtractorApiError("x", 503))).toEqual({
      failure_reason: "api_error",
      status_code: 503
    });
    expect(
      getImportErrorAnalytics(new ExtractorApiError("x", 0, undefined, { kind: "timeout" }))
    ).toEqual({ failure_reason: "network_error" });
    expect(getImportErrorAnalytics(new TypeError("Failed to fetch"))).toEqual({
      failure_reason: "network_error"
    });
  });
});

describe("describeNeedsRetry", () => {
  it("uses plain words, never scores", () => {
    const copy = describeNeedsRetry({
      diagnostics: { confidenceScore: 0.4, missingFields: ["ingredients", "steps"] },
      reason: "low_confidence",
      sourceType: "article",
      status: "needs_retry",
      suggestedAttempt: "fallback",
      userMessage: "Try a deeper extraction."
    });

    expect(copy.message).toContain("the ingredients and the steps");
    expect(`${copy.title} ${copy.message}`).not.toMatch(/confidence|deeper|extraction|%/iu);
  });
});

describe("getFriendlyImportNotes", () => {
  it("drops developer warnings and names what's missing", () => {
    const notes = getFriendlyImportNotes({
      confidenceScore: 0.95,
      missingFields: ["cookTimeMinutes", "servings"],
      strategy: "recipe-schema",
      warnings: [
        "Recipe JSON-LD was unavailable, so microdata was used instead.",
        "The oven temperature was written in Fahrenheit."
      ]
    });

    expect(notes).toEqual([
      "The page didn't mention the cooking time and how many it serves.",
      "The oven temperature was written in Fahrenheit."
    ]);
  });

  it("asks for a quick look when the recipe was read from text or photos", () => {
    expect(
      getFriendlyImportNotes({
        strategy: "article-pattern",
        warnings: ["Article extraction relies on pattern matching and may need fallback review."]
      })
    ).toEqual([
      "We tidied this one up from the page text, so give the amounts a quick look before you cook."
    ]);
    expect(getFriendlyImportNotes({ sourceKind: "photos", warnings: [] })[0]).toMatch(/photos/u);
  });
});
