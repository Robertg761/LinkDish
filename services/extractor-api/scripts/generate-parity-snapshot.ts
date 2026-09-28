/*
 * Regenerates src/modules/extract/__fixtures__/parity/extractor-outputs.json, the golden
 * snapshot parse-once-parity.test.ts compares every extractor against. Run it only when an
 * extractor's output changes on purpose, then review the JSON diff before committing:
 *
 *   pnpm --filter @linkdish/extractor-api exec tsx scripts/generate-parity-snapshot.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

import { extractArticleRecipe } from "../src/modules/extract/extractors/article/extract-article-recipe.js";
import { captureRecipeImage } from "../src/modules/extract/extractors/capture-recipe-image.js";
import { extractRecipeWebpage } from "../src/modules/extract/extractors/recipe-webpage/extract-recipe-webpage.js";
import {
  extractItemsFromSelectors,
  extractSectionContent,
  extractSectionListItems,
  extractTextBlocks
} from "../src/modules/extract/extractors/shared.js";
import { buildFallbackInputText } from "../src/modules/extract/fallback/build-fallback-input.js";
import {
  looksLikeNotFoundHtml,
  looksLikeShellHtml,
  looksLikeThinHtml
} from "../src/modules/extract/html/page-signals.js";
import { buildHtmlSourceDocument } from "../src/modules/extract/html/parsed-html-document.js";
import { detectSourceType } from "../src/modules/extract/source-detection/detect-source-type.js";

const fixturesUrl = new URL("../src/modules/extract/__fixtures__/", import.meta.url);

const cases = [
  ["recipe-jsonld.html", "https://fixtures.linkdish.test/recipe-jsonld"],
  ["recipe-microdata.html", "https://fixtures.linkdish.test/recipe-microdata"],
  ["recipe-visible-nutrition.html", "https://fixtures.linkdish.test/recipe-visible-nutrition"],
  ["article-recipe.html", "https://fixtures.linkdish.test/article-recipe"],
  ["article-weak.html", "https://fixtures.linkdish.test/article-weak"],
  ["article-no-recipe.html", "https://fixtures.linkdish.test/article-no-recipe"],
  ["recipe-graph-wprm.html", "https://fixture-kitchen.test/lemon-herb-roast-chicken/"],
  ["recipe-adapter-dom.html", "https://www.seriouseats.com/crispy-smashed-potatoes"],
  ["article-sections.html", "https://blog.fixture.test/2024/01/grandmothers-tomato-soup"]
] as const;

const selectorList = [
  ".wprm-recipe-ingredient",
  ".structured-ingredients__list li",
  "[data-testid='recipe-method'] li",
  "ul"
];

const output: Record<string, unknown> = {};

for (const [fixture, url] of cases) {
  const html = readFileSync(new URL(fixture, fixturesUrl), "utf8");
  const document = buildHtmlSourceDocument({
    url,
    finalUrl: url,
    html,
    contentType: "text/html",
    blockedSignals: [],
    statusCode: 200
  });
  const detection = detectSourceType(url, document);
  const webpage = extractRecipeWebpage(document);
  const article = extractArticleRecipe(document);

  output[fixture] = {
    url,
    title: document.title,
    description: document.description,
    detection,
    webpage,
    article,
    image: captureRecipeImage(html, url),
    shell: looksLikeShellHtml(html),
    thin: looksLikeThinHtml(html),
    notFound: looksLikeNotFoundHtml(html),
    fallbackInput: buildFallbackInputText({
      url,
      sourceType: detection.sourceType,
      sourceDocument: document,
      candidate: webpage ?? article,
      detection,
      fetchMode: "http"
    }),
    helpers: {
      sectionList: extractSectionListItems(html, /ingredients?/i),
      sectionContent: extractSectionContent(html, /(instructions?|directions?|method|steps?)/i),
      selectors: extractItemsFromSelectors(html, selectorList),
      textBlocks: extractTextBlocks(html)
    }
  };
}

const target = new URL("parity/extractor-outputs.json", fixturesUrl);
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
