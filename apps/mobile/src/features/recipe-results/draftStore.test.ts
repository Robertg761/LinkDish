import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

import { getDraftRecipeExtraction, saveDraftRecipeExtraction } from "./draftStore";

import type { SuccessfulExtractionState } from "./types";

const buildSuccessState = (): SuccessfulExtractionState => ({
  state: "success",
  fetchMode: "http",
  provenance: ["visible-text"],
  recipe: {
    title: "Soup",
    sourceUrl: "https://example.com/soup",
    sourceType: "article",
    ingredients: [{ text: "1 onion" }],
    steps: [{ index: 1, text: "Cook." }],
    servings: "4 servings",
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    nutrition: null,
    confidence: {
      score: 0.9,
      summary: "Confident extraction.",
      missingFields: [],
      notes: [],
      fieldProvenance: {
        title: "visible-text",
        ingredients: "visible-text",
        steps: "visible-text",
        servings: "visible-text",
        prepTimeMinutes: "visible-text",
        cookTimeMinutes: "visible-text",
        nutrition: null
      }
    }
  },
  sourceImages: [{ mimeType: "image/jpeg", uri: "data:image/jpeg;base64,DRAFTBYTES" }],
  strategy: "article-pattern",
  warnings: []
});

describe("draft recipe extraction store", () => {
  beforeEach(() => {
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue(null);
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("keeps a backup of unreadable drafts before replacing them", async () => {
    const corruptBlob = '[{"requestedUrl":"https://example.com/soup"';
    asyncStorageMocks.getItem.mockResolvedValue(corruptBlob);

    await expect(
      getDraftRecipeExtraction("https://example.com/soup")
    ).resolves.toBeUndefined();

    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.draftRecipeExtractions.corrupt.v1",
      corruptBlob
    );

    asyncStorageMocks.setItem.mockClear();

    await saveDraftRecipeExtraction("https://example.com/soup", buildSuccessState());

    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.draftRecipeExtractions.corrupt.v1",
      corruptBlob
    );
    expect(
      asyncStorageMocks.setItem.mock.calls.some(
        ([key]) => key === "linkdish.draftRecipeExtractions"
      )
    ).toBe(true);
  });

  it("never writes scan photo payloads into the draft blob", async () => {
    await saveDraftRecipeExtraction("https://example.com/soup", buildSuccessState());

    const draftWrite = asyncStorageMocks.setItem.mock.calls.find(
      ([key]) => key === "linkdish.draftRecipeExtractions"
    );

    expect(draftWrite).toBeDefined();
    expect(String(draftWrite?.[1])).not.toContain("DRAFTBYTES");
  });

  it("round-trips a readable draft", async () => {
    await saveDraftRecipeExtraction("https://example.com/soup", buildSuccessState());

    const draftWrite = asyncStorageMocks.setItem.mock.calls.find(
      ([key]) => key === "linkdish.draftRecipeExtractions"
    );
    asyncStorageMocks.getItem.mockResolvedValue(String(draftWrite?.[1]));

    const draft = await getDraftRecipeExtraction("https://example.com/soup");

    expect(draft?.recipe.title).toBe("Soup");
  });
});
