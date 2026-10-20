import { buildFieldProvenance } from "../shared.js";

import {
  parseRecipeText,
  withoutRecipePointer,
  type ParsedRecipeText
} from "./parse-recipe-text.js";

import type { Recipe } from "../../../../../../../packages/recipe-domain/src/index.js";
import type { ExtractionCandidate, TextSourceDocument } from "../../types.js";

/*
 * The step a video recipe gets when its caption or description lists only the ingredients, or the
 * ingredients with a few notes ("Bake at 180℃ for 20 minutes"). It points at the video instead of
 * inventing a method.
 */
export const VIDEO_METHOD_STEP = "Follow the video for the method.";

export interface TextRecipeOptions {
  /** A title from the source (a video's title) that wins over a title line in the text. */
  sourceTitle?: string | null | undefined;
  /** Used when neither the source nor the text has a title. */
  fallbackTitle: string;
  /** Video sources keep an ingredient list without a full written method (see VIDEO_METHOD_STEP). */
  isVideo?: boolean;
  strategy: ExtractionCandidate["strategy"];
  /** Where the ingredients and method were read from. */
  provenance: "visible-text" | "transcript";
  /** Extra recipe fields from the source: image, site, video, author. */
  recipe?: Partial<Recipe>;
}

export interface TextRecipeExtraction {
  candidate: ExtractionCandidate;
  /** True when the text had no full method and VIDEO_METHOD_STEP points at the video for it. */
  methodInVideo: boolean;
}

const minimumIngredientCount = 2;

/*
 * Notes between the ingredient groups, or a couple of short lines after an unlabelled list ("Bake
 * at 180℃ for 20 minutes"), are notes on the method, not the whole method.
 */
const maxPartialMethodSteps = 2;
const maxPartialMethodLength = 200;

const hasPartialMethod = (parsed: ParsedRecipeText): boolean =>
  parsed.methodSource === "notes" ||
  (parsed.structure === "layout" &&
    parsed.methodSource === "layout" &&
    parsed.steps.length <= maxPartialMethodSteps &&
    parsed.steps.join(" ").length < maxPartialMethodLength);

/** Whether a parse found an ingredient list a video recipe can be built on (the method may be in the video). */
export const hasRecipeIngredients = (parsed: ParsedRecipeText): boolean =>
  parsed.structure !== null && parsed.ingredients.length >= minimumIngredientCount;

/** Whether a parse found a whole recipe: ingredients and a method that is more than a few notes. */
export const isCompleteRecipeParse = (parsed: ParsedRecipeText): boolean =>
  hasRecipeIngredients(parsed) && parsed.steps.length >= 1 && !hasPartialMethod(parsed);

export const buildTextRecipeCandidate = (
  parsed: ParsedRecipeText,
  options: TextRecipeOptions
): TextRecipeExtraction | null => {
  if (!hasRecipeIngredients(parsed)) {
    return null;
  }

  const ingredientsOnly = parsed.steps.length === 0;

  /* Pasted text has no video to hold the method, so a list with only notes in it is no recipe. */
  if (!options.isVideo && (ingredientsOnly || parsed.methodSource === "notes")) {
    return null;
  }

  const methodInVideo = Boolean(options.isVideo) && (ingredientsOnly || hasPartialMethod(parsed));
  const sourceTitle = options.sourceTitle?.trim();
  const title = sourceTitle || parsed.title || options.fallbackTitle;
  const steps = methodInVideo ? [VIDEO_METHOD_STEP, ...parsed.steps] : parsed.steps;
  const provenance = options.provenance;

  return {
    methodInVideo,
    candidate: {
      recipe: {
        ...options.recipe,
        title,
        ingredients: parsed.ingredients.map((ingredient) => ({
          text: ingredient.text,
          section: ingredient.section
        })),
        steps: steps.map((text, index) => ({ index: index + 1, text })),
        servings: parsed.servings,
        prepTimeMinutes: parsed.prepTimeMinutes,
        cookTimeMinutes: parsed.cookTimeMinutes,
        ...(parsed.totalTimeMinutes == null ? {} : { totalTimeMinutes: parsed.totalTimeMinutes }),
        nutrition: null
      },
      strategy: options.strategy,
      evidence: [
        parsed.structure === "headings"
          ? "Read the ingredients and method under the text's own headings."
          : parsed.structure === "method"
            ? "Read a numbered method, and the ingredients from the amounts its steps name."
            : "Read a list of measured ingredients followed by method lines."
      ],
      warnings: methodInVideo
        ? [
            ingredientsOnly
              ? "The text lists the ingredients only, so the method is in the video."
              : "The text has only a few notes on the method, so the rest is in the video."
          ]
        : parsed.structure === "method"
          ? ["The recipe had no ingredient list, so this one was put together from its steps."]
          : [],
      provenance: [provenance],
      fieldProvenance: buildFieldProvenance({
        title: "visible-text",
        ingredients: provenance,
        steps: provenance,
        servings: parsed.servings ? "visible-text" : null,
        prepTimeMinutes: parsed.prepTimeMinutes == null ? null : "visible-text",
        cookTimeMinutes: parsed.cookTimeMinutes == null ? null : "visible-text",
        nutrition: null
      }),
      signals: {
        requiredFieldsInferred: methodInVideo,
        titleConfidence: sourceTitle || parsed.title ? "strong" : "weak",
        timesFromStructuredMetadata: false,
        recipeLike: true,
        detectionConfidence: "high",
        sectionCohesion: parsed.structure === "headings" ? "strong" : "medium",
        transcriptQuality: "missing",
        usedBrowserFallback: false,
        blockedSourceSignals: 0
      }
    }
  };
};

/* The opening sentence of a caption ("This pasta changed my life. Ingredients: ..."), as a title. */
const firstWords = (text: string, maxLength: number): string | null => {
  const line = text
    .split(/\n/u)
    .map((entry) =>
      entry
        .replace(/(?:^|\s)[#@][\p{L}\p{N}_.]+/gu, " ")
        .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\*+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
    )
    .find((entry) => entry.length > 0);

  if (!line) {
    return null;
  }

  const sentence = line.split(/(?<=[.!?])\s|\s(?=ingredients?\s*:)/iu)[0]?.trim() ?? line;

  /* A caption that opens with its ingredient list or an amount has no title line. */
  if (
    sentence.length > maxLength ||
    /:$/u.test(sentence) ||
    /^(?:ingredients?|instructions?|directions?|method|steps?)\b/iu.test(sentence) ||
    (/^[\d½⅓⅔¼¾⅛⅜⅝⅞]/u.test(sentence) && !/^\d+[-\s]ingredients?\b/iu.test(sentence))
  ) {
    return null;
  }

  return withoutRecipePointer(sentence.replace(/[.!?]+$/u, "")) || null;
};

/** Pasted text and TikTok captions: the recipe is read from the text alone. */
export const extractTextRecipe = (document: TextSourceDocument): TextRecipeExtraction | null => {
  const parsed = parseRecipeText(document.text);
  const isTikTok = document.origin === "tiktok";
  const captionTitle = isTikTok ? firstWords(document.text, 80) : null;

  return buildTextRecipeCandidate(parsed, {
    sourceTitle: document.title,
    fallbackTitle:
      captionTitle ??
      (isTikTok
        ? document.authorName
          ? `TikTok recipe from ${document.authorName}`
          : "TikTok recipe"
        : "Untitled recipe"),
    isVideo: isTikTok,
    strategy: "article-pattern",
    provenance: "visible-text",
    recipe: {
      sourceUrl: document.url,
      image:
        isTikTok && document.thumbnailUrl ? { url: document.thumbnailUrl, source: "og" } : null,
      ...(isTikTok
        ? {
            siteName: "TikTok",
            videoUrl: document.url,
            ...(document.authorName ? { author: document.authorName } : {})
          }
        : {})
    }
  });
};
