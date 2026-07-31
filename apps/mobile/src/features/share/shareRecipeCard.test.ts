import { beforeEach, describe, expect, it, vi } from "vitest";

const sharingMocks = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn()
}));

const shareMocks = vi.hoisted(() => ({
  share: vi.fn()
}));

vi.mock("expo-sharing", () => sharingMocks);

vi.mock("react-native", () => ({
  Share: {
    share: shareMocks.share
  }
}));

import { shareRecipeCardImage } from "./shareRecipeCard";

import type { Recipe } from "@linkdish/recipe-domain";

const buildRecipe = (): Recipe => ({
  confidence: {
    fieldProvenance: {
      cookTimeMinutes: null,
      ingredients: "visible-text",
      nutrition: null,
      prepTimeMinutes: null,
      servings: null,
      steps: "visible-text",
      title: "visible-text"
    },
    missingFields: [],
    notes: [],
    score: 0.9,
    summary: "Confident extraction."
  },
  cookTimeMinutes: null,
  image: null,
  ingredients: [{ text: "1 cup coconut" }],
  nutrition: null,
  prepTimeMinutes: null,
  servings: null,
  sourceType: "article",
  sourceUrl: "https://example.com/cake",
  steps: [{ index: 1, text: "Chill." }],
  title: "Coconut Icebox Cake"
});

describe("shareRecipeCardImage", () => {
  beforeEach(() => {
    sharingMocks.isAvailableAsync.mockReset();
    sharingMocks.shareAsync.mockReset();
    shareMocks.share.mockReset();
  });

  it("shares the captured PNG file through expo-sharing when available", async () => {
    sharingMocks.isAvailableAsync.mockResolvedValue(true);

    await shareRecipeCardImage(
      buildRecipe(),
      "file:///data/user/0/com.linkdish.app/cache/ReactNative-snapshot-image.png"
    );

    expect(sharingMocks.shareAsync).toHaveBeenCalledWith(
      "file:///data/user/0/com.linkdish.app/cache/ReactNative-snapshot-image.png",
      {
        dialogTitle: "Share LinkDish recipe card",
        mimeType: "image/png"
      }
    );
    expect(shareMocks.share).not.toHaveBeenCalled();
  });

  it("falls back to text-only sharing without leaking file URIs", async () => {
    sharingMocks.isAvailableAsync.mockResolvedValue(false);

    await shareRecipeCardImage(
      buildRecipe(),
      "file:///data/user/0/com.linkdish.app/cache/ReactNative-snapshot-image.png"
    );

    expect(sharingMocks.shareAsync).not.toHaveBeenCalled();
    expect(shareMocks.share).toHaveBeenCalledWith(
      {
        message: "Coconut Icebox Cake\nhttps://example.com/cake\nSaved with LinkDish · linkdish.ca"
      },
      {
        dialogTitle: "Share LinkDish recipe card"
      }
    );

    const shareCalls = shareMocks.share.mock.calls as Array<[{ message?: unknown }]>;
    const shareMessages = shareCalls
      .map(([payload]) => (typeof payload.message === "string" ? payload.message : ""))
      .join("\n");
    expect(shareMessages).not.toContain("file://");
  });
});
