import { Readability } from "@mozilla/readability";
import { load } from "cheerio";
import { JSDOM } from "jsdom";

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
  const adapter = getDomainAdapter(new URL(document.finalUrl).hostname.toLowerCase());
  const articleHtml = readabilityResult?.content ?? document.html;
  const articleTitle =
    readabilityResult?.title ?? document.title ?? load(document.html)("title").text().trim();
  const adapterIngredients = adapter
    ? extractItemsFromSelectors(document.html, adapter.selectors.ingredients)
    : [];
  const adapterSteps = adapter
    ? extractItemsFromSelectors(document.html, adapter.selectors.steps)
    : [];

  const ingredientItems =
    adapterIngredients.length > 0
      ? adapterIngredients
      : [
          ...extractSectionListItems(articleHtml, /ingredients?/i),
          ...extractSectionContent(articleHtml, /ingredients?/i)
        ];
  const stepItems =
    adapterSteps.length > 0
      ? adapterSteps
      : [
          ...extractSectionListItems(articleHtml, /(instructions?|directions?|method|steps?)/i),
          ...extractSectionContent(articleHtml, /(instructions?|directions?|method|steps?)/i)
        ];
  const textBlocks = extractTextBlocks(articleHtml);
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
  const flattenedText = load(articleHtml).text();

  if (!signals.recipeLike) {
    return null;
  }

  return {
    recipe: {
      title: articleTitle,
      sourceUrl: document.finalUrl,
      sourceType: "article",
      image: captureRecipeImage(document.html, document.finalUrl),
      ingredients: toIngredientLines(inferredIngredients),
      steps: toStepLines(inferredSteps),
      servings: extractServingsFromText(flattenedText),
      prepTimeMinutes: extractMinutesFromText(flattenedText, "prep"),
      cookTimeMinutes: extractMinutesFromText(flattenedText, "cook"),
      nutrition: extractNutritionFromText(flattenedText)
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
      servings: extractServingsFromText(flattenedText) ? "visible-text" : null,
      prepTimeMinutes:
        extractMinutesFromText(flattenedText, "prep") == null ? null : "visible-text",
      cookTimeMinutes:
        extractMinutesFromText(flattenedText, "cook") == null ? null : "visible-text",
      nutrition: extractNutritionFromText(flattenedText) ? "visible-text" : null
    }),
    signals
  };
};
