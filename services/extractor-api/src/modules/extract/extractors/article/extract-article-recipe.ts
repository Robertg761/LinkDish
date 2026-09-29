import { Readability } from "@mozilla/readability";
import { load } from "cheerio";
import { JSDOM } from "jsdom";

import { getParsedHtmlDocument } from "../../html/parsed-html-document.js";
import { getDomainAdapter } from "../../source-detection/domain-adapters.js";
import { captureRecipeImage } from "../capture-recipe-image.js";
import {
  buildFieldProvenance,
  extractMinutesFromText,
  extractItemsFromSelectors,
  extractNutritionFromText,
  extractSectionContent,
  extractSectionListItems,
  extractServingsFromText,
  extractTextBlocks,
  looksLikeIngredient,
  looksLikeStep,
  parseTextRecipeSignals,
  toIngredientLines,
  toStepLines
} from "../shared.js";

import type { ExtractionCandidate, HtmlSourceDocument } from "../../types.js";

export const extractArticleRecipe = (document: HtmlSourceDocument): ExtractionCandidate | null => {
  const dom = new JSDOM(document.html, {
    url: document.finalUrl
  });
  const readabilityResult = new Readability(dom.window.document).parse();
  const parsedDocument = getParsedHtmlDocument(document);
  const adapter = getDomainAdapter(new URL(document.finalUrl).hostname.toLowerCase());
  /*
   * The Readability output (or the page itself when Readability finds nothing)
   * is parsed once and shared by every section helper below.
   */
  const article$ =
    readabilityResult?.content == null ? parsedDocument.$ : load(readabilityResult.content);
  const articleTitle =
    readabilityResult?.title ?? document.title ?? parsedDocument.titleText.trim();
  const adapterIngredients = adapter
    ? extractItemsFromSelectors(parsedDocument.$, adapter.selectors.ingredients)
    : [];
  const adapterSteps = adapter
    ? extractItemsFromSelectors(parsedDocument.$, adapter.selectors.steps)
    : [];

  const ingredientItems =
    adapterIngredients.length > 0
      ? adapterIngredients
      : [
          ...extractSectionListItems(article$, /ingredients?/i),
          ...extractSectionContent(article$, /ingredients?/i)
        ];
  const stepItems =
    adapterSteps.length > 0
      ? adapterSteps
      : [
          ...extractSectionListItems(article$, /(instructions?|directions?|method|steps?)/i),
          ...extractSectionContent(article$, /(instructions?|directions?|method|steps?)/i)
        ];
  const textBlocks = extractTextBlocks(article$);
  const inferredIngredients =
    ingredientItems.length > 0
      ? ingredientItems
      : textBlocks
          .filter((block) => looksLikeIngredient(block) || (/\d/.test(block) && block.length < 120))
          .slice(0, 14);
  const inferredSteps =
    stepItems.length > 0
      ? stepItems
      : textBlocks.filter((block) => looksLikeStep(block) || block.length > 45).slice(0, 10);
  const heuristicRecipeLike =
    ingredientItems.length > 0 ||
    stepItems.length > 0 ||
    (textBlocks.some((block) => looksLikeIngredient(block)) &&
      textBlocks.some((block) => looksLikeStep(block)));
  const signals = {
    ...parseTextRecipeSignals(textBlocks).signals,
    recipeLike: heuristicRecipeLike
  };
  if (!signals.recipeLike) {
    return null;
  }

  const flattenedText = article$.text();
  const servings = extractServingsFromText(flattenedText);
  const prepTimeMinutes = extractMinutesFromText(flattenedText, "prep");
  const cookTimeMinutes = extractMinutesFromText(flattenedText, "cook");
  const nutrition = extractNutritionFromText(flattenedText);

  return {
    recipe: {
      title: articleTitle,
      sourceUrl: document.finalUrl,
      sourceType: "article",
      image: captureRecipeImage(parsedDocument, document.finalUrl),
      ingredients: toIngredientLines(inferredIngredients),
      steps: toStepLines(inferredSteps),
      servings,
      prepTimeMinutes,
      cookTimeMinutes,
      nutrition
    },
    strategy: "article-pattern",
    evidence: [
      adapter
        ? `Parsed article content with Readability and ${adapter.key} selector hints.`
        : "Parsed article content with Readability and section heuristics."
    ],
    warnings: ["Article extraction relies on pattern matching and may need fallback review."],
    provenance: ["readability", "visible-text"],
    fieldProvenance: buildFieldProvenance({
      title: "visible-text",
      ingredients: "visible-text",
      steps: "visible-text",
      servings: servings ? "visible-text" : null,
      prepTimeMinutes: prepTimeMinutes == null ? null : "visible-text",
      cookTimeMinutes: cookTimeMinutes == null ? null : "visible-text",
      nutrition: nutrition ? "visible-text" : null
    }),
    signals
  };
};
