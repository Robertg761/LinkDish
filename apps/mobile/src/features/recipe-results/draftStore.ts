import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  createSavedRecipeRecord,
  normalizeSavedRecipeRecord,
  type SavedRecipeRecord
} from "../saved-recipes/store";

import type { SuccessfulExtractionState } from "./types";

const DRAFT_EXTRACTIONS_STORAGE_KEY = "linkdish.draftRecipeExtractions";
const MAX_DRAFT_EXTRACTIONS = 20;

interface DraftRecipeExtractionRecord {
  requestedUrl: string;
  savedRecipe: SavedRecipeRecord;
  updatedAt: string;
}

const normalizeDraftRecipeExtractionRecord = (
  value: unknown
): DraftRecipeExtractionRecord | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    requestedUrl?: unknown;
    savedRecipe?: {
      recipe?: {
        sourceUrl?: unknown;
        title?: unknown;
      };
      savedAt?: unknown;
    };
    updatedAt?: unknown;
  };
  const savedRecipe = normalizeSavedRecipeRecord(candidate.savedRecipe);

  if (
    typeof candidate.requestedUrl !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    savedRecipe == null
  ) {
    return null;
  }

  return {
    requestedUrl: candidate.requestedUrl,
    savedRecipe,
    updatedAt: candidate.updatedAt
  };
};

const parseDraftRecipeExtractions = (
  serializedDrafts: string | null
): DraftRecipeExtractionRecord[] => {
  if (!serializedDrafts) {
    return [];
  }

  try {
    const parsed = JSON.parse(serializedDrafts) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(normalizeDraftRecipeExtractionRecord)
      .filter((entry): entry is DraftRecipeExtractionRecord => entry !== null);
  } catch {
    return [];
  }
};

const readDraftRecipeExtractions = async (): Promise<DraftRecipeExtractionRecord[]> => {
  const serializedDrafts = await AsyncStorage.getItem(DRAFT_EXTRACTIONS_STORAGE_KEY);
  return parseDraftRecipeExtractions(serializedDrafts);
};

export const getDraftRecipeExtraction = async (
  url: string
): Promise<SavedRecipeRecord | undefined> => {
  const drafts = await readDraftRecipeExtractions();
  return drafts.find(
    (entry) => entry.requestedUrl === url || entry.savedRecipe.recipe.sourceUrl === url
  )?.savedRecipe;
};

export const saveDraftRecipeExtraction = async (
  requestedUrl: string,
  state: SuccessfulExtractionState
): Promise<void> => {
  const savedRecipe = createSavedRecipeRecord({
    ...state,
    sourceImages: undefined
  });
  const drafts = await readDraftRecipeExtractions();
  const nextDrafts = [
    {
      requestedUrl,
      savedRecipe,
      updatedAt: new Date().toISOString()
    },
    ...drafts.filter(
      (entry) =>
        entry.requestedUrl !== requestedUrl &&
        entry.savedRecipe.recipe.sourceUrl !== savedRecipe.recipe.sourceUrl
    )
  ].slice(0, MAX_DRAFT_EXTRACTIONS);

  await AsyncStorage.setItem(DRAFT_EXTRACTIONS_STORAGE_KEY, JSON.stringify(nextDrafts));
};
