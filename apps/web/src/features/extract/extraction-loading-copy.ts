import type { ImportKind } from "./import-outcome";

/**
 * The staged progress shown while a recipe is imported. The API answers in one go, so stages
 * advance on a gentle schedule that matches how long each part usually takes; the last stage
 * simply waits for the answer.
 */

export interface ExtractionStage {
  label: string;
  /** A little kitchen flavour under the stage label. */
  detail: string;
  /** When this stage starts, in milliseconds after the import began. */
  startsAtMs: number;
}

/** After this long an import is slower than usual and we say so (with a way out). */
export const SLOW_IMPORT_MS = 12_000;

const stage = (label: string, detail: string, startsAtMs: number): ExtractionStage => ({
  detail,
  label,
  startsAtMs
});

export const getExtractionStages = (
  kind: ImportKind,
  attempt: "primary" | "fallback"
): readonly ExtractionStage[] => {
  if (kind === "images") {
    return [
      stage("Sending your photos", "Warming up the oven…", 0),
      stage("Reading the recipe", "Squinting at the handwriting…", 2_500),
      stage("Tidying up", "Plating your recipe…", 11_000)
    ];
  }

  if (kind === "text") {
    return [
      stage("Reading your text", "Skimming for the good stuff…", 0),
      stage("Finding the recipe", "Sorting ingredients from steps…", 2_000),
      stage("Tidying up", "Plating your recipe…", 9_000)
    ];
  }

  if (attempt === "fallback") {
    return [
      stage("Taking a closer look", "Rolling up our sleeves…", 0),
      stage("Reading it with AI help", "Chopping it down to the good stuff…", 2_500),
      stage("Tidying up", "Plating your recipe…", 12_000)
    ];
  }

  return [
    stage("Fetching the page", "Skimming off the ads…", 0),
    stage("Reading the recipe", "Chopping it down to the good stuff…", 2_200),
    stage("Tidying up", "Tasting for seasoning…", 5_500)
  ];
};

/** Which stage is showing after `elapsedMs`. */
export const getActiveStageIndex = (
  stages: readonly ExtractionStage[],
  elapsedMs: number
): number => {
  let index = 0;

  stages.forEach((candidate, candidateIndex) => {
    if (elapsedMs >= candidate.startsAtMs) {
      index = candidateIndex;
    }
  });

  return index;
};

/** "0:07", "1:12" */
export const formatElapsed = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
