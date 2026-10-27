import { describe, expect, it } from "vitest";

import {
  createPendingTextImport,
  findCaptionSourceUrl,
  getOnlyLink,
  getPendingTextImport,
  getTextInputProblem,
  MAX_IMPORT_TEXT_CHARS,
  removePendingTextImport,
  TEXT_IMPORT_URL_PREFIX
} from "./textImport";

describe("text import input", () => {
  it("needs at least 20 characters and at most 20,000, trimmed", () => {
    expect(getTextInputProblem("")).toBe("too_short");
    expect(getTextInputProblem(`   ${"a".repeat(19)}   `)).toBe("too_short");
    expect(getTextInputProblem("2 eggs, 1 cup flour. Whisk and fry.")).toBeNull();
    expect(getTextInputProblem("a".repeat(MAX_IMPORT_TEXT_CHARS + 1))).toBe("too_long");
  });

  it("keeps a caption's one link as its source", () => {
    expect(
      findCaptionSourceUrl("Best pancakes 🥞 https://www.tiktok.com/@cook/video/1 2 eggs, flour")
    ).toBe("https://www.tiktok.com/@cook/video/1");
  });

  it("has no source when the caption has several links or none", () => {
    expect(
      findCaptionSourceUrl("See https://a.example.com/one and https://b.example.com/two")
    ).toBeUndefined();
    expect(findCaptionSourceUrl("2 eggs. A pinch of salt.Enjoy!")).toBeUndefined();
  });

  it("treats a paste that is only a link as a link", () => {
    expect(getOnlyLink("  https://example.com/soup  ")).toBe("https://example.com/soup");
    expect(getOnlyLink("Try this https://example.com/soup")).toBe("https://example.com/soup");
    expect(
      getOnlyLink("Soup: 2 onions, 1 litre stock, simmer 20 minutes. https://example.com/soup")
    ).toBeUndefined();
  });
});

describe("pending text imports", () => {
  it("holds the trimmed text under a route key until it is released", () => {
    const pending = createPendingTextImport("  Pancakes: 2 eggs, 1 cup flour, fry.  ");

    expect(pending.sourceUrl.startsWith(TEXT_IMPORT_URL_PREFIX)).toBe(true);
    expect(pending.text).toBe("Pancakes: 2 eggs, 1 cup flour, fry.");
    expect(pending.captionSourceUrl).toBeUndefined();
    expect(getPendingTextImport(pending.id)).toEqual(pending);

    removePendingTextImport(pending.id);
    expect(getPendingTextImport(pending.id)).toBeUndefined();
  });

  it("sends a caption's link as the recipe's source", () => {
    const pending = createPendingTextImport(
      "So good https://www.instagram.com/p/abc/ 2 eggs, 1 cup flour, fry."
    );

    expect(pending.captionSourceUrl).toBe("https://www.instagram.com/p/abc/");
    removePendingTextImport(pending.id);
  });
});
