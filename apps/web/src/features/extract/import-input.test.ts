import { describe, expect, it } from "vitest";

import {
  getImportHost,
  getTextInputProblem,
  isSocialImportUrl,
  MAX_BATCH_LINKS,
  parseLinkList,
  parseRecipeLinkInput
} from "./import-input";

describe("parseRecipeLinkInput", () => {
  it("accepts plain http and https links", () => {
    expect(parseRecipeLinkInput("https://example.com/recipe")).toEqual({
      ok: true,
      url: "https://example.com/recipe"
    });
    expect(parseRecipeLinkInput("  http://example.com/recipe  ")).toEqual({
      ok: true,
      url: "http://example.com/recipe"
    });
  });

  it("adds https:// to scheme-less links", () => {
    expect(parseRecipeLinkInput("www.seriouseats.com/chili")).toEqual({
      ok: true,
      url: "https://www.seriouseats.com/chili"
    });
    expect(parseRecipeLinkInput("seriouseats.com/chili")).toEqual({
      ok: true,
      url: "https://seriouseats.com/chili"
    });
  });

  it("pulls the link out of share text and drops trailing punctuation", () => {
    expect(parseRecipeLinkInput("Look at this!! https://site.com/recipe).")).toEqual({
      ok: true,
      url: "https://site.com/recipe"
    });
    expect(parseRecipeLinkInput("Made this last night: www.site.com/pie, so good")).toEqual({
      ok: true,
      url: "https://www.site.com/pie"
    });
  });

  it("explains what is wrong with other input", () => {
    expect(parseRecipeLinkInput("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parseRecipeLinkInput("ftp://example.com/recipe")).toEqual({
      ok: false,
      reason: "unsupported_scheme"
    });
    expect(parseRecipeLinkInput("grandma's lasagna")).toEqual({ ok: false, reason: "not_a_link" });
  });
});

describe("parseLinkList", () => {
  it("finds every distinct link, one per line or space separated", () => {
    expect(
      parseLinkList(
        "https://a.com/one\nwww.b.com/two  https://a.com/one?utm_source=x\n\nnot a link\nc.org/three."
      )
    ).toEqual(["https://a.com/one", "https://www.b.com/two", "https://c.org/three"]);
  });

  it("caps a batch", () => {
    const text = Array.from({ length: 40 }, (_, index) => `https://site.com/r${index}`).join("\n");
    expect(parseLinkList(text)).toHaveLength(MAX_BATCH_LINKS);
  });
});

describe("source helpers", () => {
  it("recognises social posts that need AI help", () => {
    expect(isSocialImportUrl("https://www.tiktok.com/@cook/video/1")).toBe(true);
    expect(isSocialImportUrl("https://vm.tiktok.com/abc/")).toBe(true);
    expect(isSocialImportUrl("https://www.instagram.com/p/xyz/")).toBe(true);
    expect(isSocialImportUrl("https://pin.it/abc")).toBe(true);
    expect(isSocialImportUrl("https://www.youtube.com/shorts/abcdefg")).toBe(true);
    expect(isSocialImportUrl("https://www.youtube.com/watch?v=abcdefg")).toBe(false);
    expect(isSocialImportUrl("https://www.seriouseats.com/chili")).toBe(false);
  });

  it("shortens hosts", () => {
    expect(getImportHost("https://www.seriouseats.com/x")).toBe("seriouseats.com");
    expect(getImportHost("https://m.allrecipes.com/x")).toBe("allrecipes.com");
    expect(getImportHost("nope")).toBeNull();
  });

  it("checks pasted text length after trimming", () => {
    expect(getTextInputProblem("   short   ")).toBe("too_short");
    expect(getTextInputProblem("2 eggs, 1 cup flour, whisk and bake.")).toBeNull();
    expect(getTextInputProblem("x".repeat(20_001))).toBe("too_long");
  });
});
