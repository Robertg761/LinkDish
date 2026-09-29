import { beforeEach, describe, expect, it } from "vitest";

import { clearImportDraft, readImportDraft, writeImportDraft } from "./import-draft";
import { formatImportUsage, toImportUsage } from "./use-import-usage";

import type { ExtractRecipeSuccess } from "@linkdish/api-contracts";

describe("import usage", () => {
  it("reads monthly and lifetime allowances from the API's quota", () => {
    expect(
      toImportUsage({
        limit: 100,
        meteringMode: "paid_monthly",
        monthlyLimit: 100,
        remaining: 96,
        remainingThisMonth: 96,
        resetsAt: "2026-10-01T00:00:00.000Z"
      })
    ).toEqual({ limit: 100, monthly: true, remaining: 96, resetsAt: "2026-10-01T00:00:00.000Z" });
    expect(
      toImportUsage({
        limit: 3,
        meteringMode: "free_lifetime",
        monthlyLimit: null,
        remaining: 2,
        remainingThisMonth: null,
        resetsAt: null
      })
    ).toEqual({ limit: 3, monthly: false, remaining: 2, resetsAt: null });
    expect(toImportUsage(null)).toBeNull();
    expect(
      toImportUsage({
        limit: 0,
        meteringMode: "disabled",
        monthlyLimit: null,
        remaining: 0,
        remainingThisMonth: null,
        resetsAt: null
      })
    ).toBeNull();
  });

  it("says it kindly", () => {
    expect(formatImportUsage({ limit: 3, monthly: false, remaining: 2, resetsAt: null })).toBe(
      "2 of 3 free imports left"
    );
    expect(formatImportUsage({ limit: 3, monthly: false, remaining: 0, resetsAt: null })).toBe(
      "No free imports left"
    );
    expect(formatImportUsage({ limit: 100, monthly: true, remaining: 1, resetsAt: null })).toBe(
      "1 import left this month"
    );
  });
});

describe("import draft", () => {
  const response = {
    extraction: {
      confidenceScore: 0.9,
      fetchMode: "http",
      missingFields: [],
      provenance: ["jsonld"],
      sourceType: "recipe-webpage",
      strategy: "recipe-schema",
      warnings: []
    },
    recipe: { title: "Soup" },
    status: "success"
  } as unknown as ExtractRecipeSuccess;

  beforeEach(() => {
    sessionStorage.clear();
  });

  it("keeps an unsaved import for the rest of the session", () => {
    writeImportDraft({
      attempt: "primary",
      correlationId: "c1",
      request: { kind: "url", url: "https://example.com/soup" },
      response
    });

    expect(readImportDraft()).toMatchObject({
      correlationId: "c1",
      request: { url: "https://example.com/soup" },
      response: { recipe: { title: "Soup" } }
    });

    clearImportDraft();
    expect(readImportDraft()).toBeNull();
  });

  it("drops photos that are too big to keep, but keeps the recipe", () => {
    writeImportDraft({
      attempt: "fallback",
      correlationId: "c2",
      request: {
        images: [
          { dataUrl: `data:image/jpeg;base64,${"a".repeat(3_000_000)}`, mimeType: "image/jpeg" }
        ],
        kind: "images",
        sourceUrl: "https://linkdish.app/image-imports/web-1"
      },
      response
    });

    expect(readImportDraft()?.request).toMatchObject({ images: [], kind: "images" });
  });

  it("ignores a corrupt draft", () => {
    sessionStorage.setItem("linkdish:web:import-draft:v1", "{not json");
    expect(readImportDraft()).toBeNull();
    expect(sessionStorage.getItem("linkdish:web:import-draft:v1")).toBeNull();
  });
});
