import { load } from "cheerio";

import type { FallbackExtractionInput } from "../types.js";

const maxVisibleTextLength = 12_000;
const maxHeadings = 18;

const normalizeText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

const buildCandidateSummary = (input: FallbackExtractionInput): string => {
  if (!input.candidate) {
    return "No deterministic candidate was available.";
  }

  return JSON.stringify(
    {
      title: input.candidate.recipe.title ?? null,
      ingredients: input.candidate.recipe.ingredients ?? [],
      steps: input.candidate.recipe.steps ?? [],
      servings: input.candidate.recipe.servings ?? null,
      prepTimeMinutes: input.candidate.recipe.prepTimeMinutes ?? null,
      cookTimeMinutes: input.candidate.recipe.cookTimeMinutes ?? null,
      nutrition: input.candidate.recipe.nutrition ?? null,
      warnings: input.candidate.warnings,
      evidence: input.candidate.evidence
    },
    null,
    2
  );
};

const buildHtmlSourceSummary = (html: string): string => {
  const $ = load(html);
  $("script, style, noscript, template, svg, iframe").remove();

  const title = normalizeText(
    $('meta[property="og:title"]').attr("content") ||
      $('meta[name="twitter:title"]').attr("content") ||
      $("title").first().text()
  );
  const description = normalizeText(
    $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content")
  );
  const headings = $("h1, h2, h3")
    .map((_, element) => normalizeText($(element).text()))
    .get()
    .filter(Boolean)
    .slice(0, maxHeadings);
  const visibleText = normalizeText(
    $("article, main, [role='main']").first().text() || $("body").text()
  ).slice(0, maxVisibleTextLength);

  return [
    `Page title: ${title || "Unknown"}`,
    `Meta description: ${description || "Unknown"}`,
    `Headings: ${headings.join(" | ") || "None"}`,
    `Visible text excerpt: ${visibleText || "Unavailable"}`
  ].join("\n");
};

export const buildFallbackInputText = (input: FallbackExtractionInput): string => {
  const sourceDocument =
    input.sourceDocument.kind === "html"
      ? buildHtmlSourceSummary(input.sourceDocument.html)
      : input.sourceDocument.kind === "youtube"
        ? [
            `Title: ${input.sourceDocument.title ?? "Unknown"}`,
            `Description: ${input.sourceDocument.description ?? "Unknown"}`,
            `Transcript: ${input.sourceDocument.transcript ?? "Unavailable"}`,
            `Chapters: ${input.sourceDocument.chapters.join(" | ") || "Unavailable"}`
          ].join("\n")
        : [
            `Image count: ${input.sourceDocument.images.length}`,
            "The recipe source is attached as image input. Read only visible recipe text from the images."
          ].join("\n");

  return [
    "Extract a clean cooking recipe from the provided source.",
    "Only return recipe data that is directly supported by the source. Be conservative with inferences.",
    'Preserve ingredient grouping exactly when the source has sections. For example, if a recipe has Cake and Frosting ingredients, attach section "Cake" to cake ingredients and section "Frosting" to frosting ingredients.',
    "Method steps must make ingredient usage clear enough for cook mode. When a step uses only one section or a subset of ingredients, name that section or ingredients in the step text instead of relying on the user to look back.",
    `Source type: ${input.sourceType}`,
    `Detection confidence: ${input.detection.confidence}`,
    `Fetch mode: ${input.fetchMode}`,
    `Source URL: ${input.url}`,
    "Deterministic candidate:",
    buildCandidateSummary(input),
    "Source document:",
    sourceDocument
  ].join("\n\n");
};
