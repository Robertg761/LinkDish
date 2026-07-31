import {
  buildFieldProvenance,
  extractMinutesFromText,
  extractServingsFromText,
  toIngredientLines,
  toStepLines,
  uniqueNonEmptyText
} from "../shared.js";

import type { ExtractionCandidate, YouTubeSourceDocument } from "../../types.js";

const pullSectionLines = (text: string, headingPattern: RegExp): string[] => {
  const lines = text.split(/\n+/).map((line) => line.trim());
  const section: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (headingPattern.test(line)) {
      collecting = true;
      continue;
    }

    if (
      collecting &&
      (/^[A-Z][A-Za-z ]+:$/.test(line) ||
        /^(prep|cook)\s+time[:\s]/i.test(line) ||
        /^serves?\b/i.test(line) ||
        /^ingredients?:/i.test(line))
    ) {
      break;
    }

    if (collecting && line.length > 0) {
      section.push(line);
    }
  }

  return uniqueNonEmptyText(section);
};

export const extractYouTubeRecipe = (
  document: YouTubeSourceDocument
): ExtractionCandidate | null => {
  const transcript = document.transcript?.trim();
  const description = document.description?.trim() ?? "";
  const chapterText = document.chapters.join("\n");
  const combinedText = [description, chapterText, transcript].filter(Boolean).join("\n");
  const ingredientLines = pullSectionLines(combinedText, /^ingredients?:?/i);
  const stepLines = pullSectionLines(combinedText, /^(instructions?|directions?|method|steps?):?/i);
  const fallbackDescriptionLines = combinedText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (
    !transcript &&
    ingredientLines.length === 0 &&
    stepLines.length === 0 &&
    !/recipe|ingredients?/i.test(description)
  ) {
    return null;
  }

  const fallbackTranscriptSentences = transcript
    ? transcript
        .split(/[.?!]\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean)
    : fallbackDescriptionLines;
  const ingredientSource =
    ingredientLines.length > 0
      ? ingredientLines
      : fallbackTranscriptSentences
          .filter((sentence) => /cup|tbsp|tsp|ingredient/i.test(sentence))
          .slice(0, 10);
  const stepSource =
    stepLines.length > 0
      ? stepLines
      : fallbackTranscriptSentences.filter((sentence) => sentence.length > 20).slice(0, 8);
  const usesTranscript = Boolean(transcript);

  return {
    recipe: {
      title: document.title ?? `YouTube recipe ${document.videoId}`,
      sourceUrl: document.url,
      sourceType: "youtube",
      image: {
        source: "youtube-thumb",
        url: `https://i.ytimg.com/vi/${encodeURIComponent(document.videoId)}/hqdefault.jpg`
      },
      ingredients: toIngredientLines(ingredientSource),
      steps: toStepLines(stepSource),
      servings: extractServingsFromText(combinedText),
      prepTimeMinutes: extractMinutesFromText(combinedText, "prep"),
      cookTimeMinutes: extractMinutesFromText(combinedText, "cook"),
      nutrition: null
    },
    strategy: "youtube-transcript",
    evidence: [
      usesTranscript
        ? "Parsed YouTube transcript and metadata for recipe cues."
        : "Parsed YouTube description and chapter metadata for recipe cues."
    ],
    warnings: [
      usesTranscript
        ? "YouTube extraction is transcript-dependent and may miss unspoken details."
        : "YouTube extraction used description-level cues because a transcript was unavailable."
    ],
    provenance: usesTranscript ? ["transcript", "visible-text"] : ["visible-text"],
    fieldProvenance: buildFieldProvenance({
      title: "visible-text",
      ingredients: usesTranscript ? "transcript" : "visible-text",
      steps: usesTranscript ? "transcript" : "visible-text",
      servings: extractServingsFromText(combinedText) ? "visible-text" : null,
      prepTimeMinutes: extractMinutesFromText(combinedText, "prep") == null ? null : "visible-text",
      cookTimeMinutes: extractMinutesFromText(combinedText, "cook") == null ? null : "visible-text",
      nutrition: null
    }),
    signals: {
      requiredFieldsInferred: !usesTranscript,
      titleConfidence: document.title ? "strong" : "weak",
      timesFromStructuredMetadata: false,
      recipeLike:
        ingredientLines.length > 0 ||
        stepLines.length > 0 ||
        /ingredients?|instructions?|recipe/i.test(combinedText),
      detectionConfidence: usesTranscript ? "high" : "medium",
      sectionCohesion:
        ingredientLines.length > 0 && stepLines.length > 0
          ? "strong"
          : ingredientLines.length > 0 || stepLines.length > 0
            ? "medium"
            : "weak",
      transcriptQuality: usesTranscript ? "strong" : "missing",
      usedBrowserFallback: false,
      blockedSourceSignals: 0
    }
  };
};
