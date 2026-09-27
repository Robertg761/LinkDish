import { readFileSync } from "node:fs";

import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import { extractArticleRecipe } from "../extractors/article/extract-article-recipe";
import { captureRecipeImage } from "../extractors/capture-recipe-image";
import { extractRecipeWebpage } from "../extractors/recipe-webpage/extract-recipe-webpage";
import {
  extractItemsFromSelectors,
  extractSectionContent,
  extractSectionListItems,
  extractTextBlocks
} from "../extractors/shared";
import { buildFallbackInputText } from "../fallback/build-fallback-input";
import { detectSourceType } from "../source-detection/detect-source-type";

import { looksLikeNotFoundHtml, looksLikeShellHtml, looksLikeThinHtml } from "./page-signals";
import { buildHtmlSourceDocument, getParsedHtmlDocument } from "./parsed-html-document";

/*
 * extractor-outputs.json was generated from the extractors *before* they were
 * moved onto one shared parse per document (each helper used to re-parse the
 * page). These tests prove the single-parse pipeline returns identical output
 * for every fixture, including a larger @graph/WPRM page, an adapter DOM page
 * and a sectioned article.
 */
type ParitySnapshot = Record<
  string,
  {
    url: string;
    title: string | null;
    description: string | null;
    detection: unknown;
    webpage: unknown;
    article: unknown;
    image: unknown;
    shell: boolean;
    thin: boolean;
    notFound: boolean;
    fallbackInput: string;
    helpers: {
      sectionList: string[];
      sectionContent: string[];
      selectors: string[];
      textBlocks: string[];
    };
  }
>;

const snapshot = JSON.parse(
  readFileSync(new URL("../__fixtures__/parity/extractor-outputs.json", import.meta.url), "utf8")
) as ParitySnapshot;

const loadFixture = (fileName: string) =>
  readFileSync(new URL(`../__fixtures__/${fileName}`, import.meta.url), "utf8");

/* JSON round-trip so `undefined` fields compare the way the snapshot stored them. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null)) as unknown;

const selectorList = [
  ".wprm-recipe-ingredient",
  ".structured-ingredients__list li",
  "[data-testid='recipe-method'] li",
  "ul"
];

describe("single-parse extraction parity", () => {
  for (const [fixture, expected] of Object.entries(snapshot)) {
    it(`matches the pre-refactor output for ${fixture}`, () => {
      const html = loadFixture(fixture);
      const document = buildHtmlSourceDocument({
        url: expected.url,
        finalUrl: expected.url,
        html,
        contentType: "text/html",
        blockedSignals: [],
        statusCode: 200
      });
      const detection = detectSourceType(expected.url, document);
      const webpage = extractRecipeWebpage(document);
      const article = extractArticleRecipe(document);
      const $ = getParsedHtmlDocument(document).$;

      expect(document.title).toBe(expected.title);
      expect(document.description).toBe(expected.description);
      expect(asJson(detection)).toEqual(expected.detection);
      expect(asJson(webpage)).toEqual(expected.webpage);
      expect(asJson(article)).toEqual(expected.article);
      expect(asJson(captureRecipeImage(document, expected.url))).toEqual(expected.image);
      expect(asJson(captureRecipeImage(html, expected.url))).toEqual(expected.image);
      expect(looksLikeShellHtml(document)).toBe(expected.shell);
      expect(looksLikeThinHtml(document)).toBe(expected.thin);
      expect(looksLikeNotFoundHtml(document)).toBe(expected.notFound);
      expect(
        buildFallbackInputText({
          url: expected.url,
          sourceType: detection.sourceType,
          sourceDocument: document,
          candidate: webpage ?? article,
          detection,
          fetchMode: "http"
        })
      ).toBe(expected.fallbackInput);
      expect(extractSectionListItems($, /ingredients?/i)).toEqual(expected.helpers.sectionList);
      expect(extractSectionContent($, /(instructions?|directions?|method|steps?)/i)).toEqual(
        expected.helpers.sectionContent
      );
      expect(extractItemsFromSelectors($, selectorList)).toEqual(expected.helpers.selectors);
      expect(extractTextBlocks($)).toEqual(expected.helpers.textBlocks);
      expect(extractTextBlocks(html)).toEqual(expected.helpers.textBlocks);
    });
  }

  it("parses each fetched document once and never mutates the shared parse", () => {
    const html = loadFixture("recipe-graph-wprm.html");
    const document = buildHtmlSourceDocument({
      url: "https://fixture-kitchen.test/lemon-herb-roast-chicken/",
      finalUrl: "https://fixture-kitchen.test/lemon-herb-roast-chicken/",
      html,
      contentType: "text/html",
      blockedSignals: [],
      statusCode: 200
    });
    const parsed = getParsedHtmlDocument(document);
    const scriptCountBefore = parsed.$("script").length;

    extractRecipeWebpage(document);
    extractArticleRecipe(document);
    detectSourceType(document.finalUrl, document);
    looksLikeShellHtml(document);
    buildFallbackInputText({
      url: document.url,
      sourceType: "recipe-webpage",
      sourceDocument: document,
      candidate: null,
      detection: {
        sourceType: "recipe-webpage",
        confidence: "high",
        reasons: [],
        adapterKey: null
      },
      fetchMode: "http"
    });

    expect(getParsedHtmlDocument(document)).toBe(parsed);
    expect(parsed.$("script").length).toBe(scriptCountBefore);
    expect(scriptCountBefore).toBe(load(html)("script").length);
  });

  it("does not reuse a parse for a copy of the document with different HTML", () => {
    const document = buildHtmlSourceDocument({
      url: "https://example.test/a",
      finalUrl: "https://example.test/a",
      html: "<html><title>First</title></html>",
      contentType: "text/html",
      blockedSignals: [],
      statusCode: 200
    });
    const copy = { ...document, html: "<html><title>Second</title></html>" };

    expect(getParsedHtmlDocument(document).titleText).toBe("First");
    expect(getParsedHtmlDocument(copy).titleText).toBe("Second");
  });

  it("reads meta tags like the first-match attribute selectors it replaced", () => {
    const parsed = getParsedHtmlDocument(
      [
        "<head>",
        '<meta property="og:title">',
        '<meta property="og:title" content="Second">',
        '<meta name="description" content=" Desc ">',
        '<meta property="OG:TITLE" content="Upper">',
        "</head>"
      ].join("")
    );
    const $ = parsed.$;

    expect(parsed.metaContent("property", "og:title")).toBe(
      $('meta[property="og:title"]').attr("content")
    );
    expect(parsed.metaContent("property", "og:title")).toBeUndefined();
    expect(parsed.metaContent("name", "description")).toBe(" Desc ");
    expect(parsed.metaContent("property", "OG:TITLE")).toBe("Upper");
    expect(parsed.metaContent("name", "twitter:title")).toBeUndefined();
  });
});
