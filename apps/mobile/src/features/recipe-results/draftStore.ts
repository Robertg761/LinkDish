import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  createSavedRecipeRecord,
  normalizeSavedRecipeRecord,
  type SavedRecipeRecord
} from "../saved-recipes/store";

import type { SuccessfulExtractionState } from "./types";

const DRAFT_EXTRACTIONS_STORAGE_KEY = "linkdish.draftRecipeExtractions";
const DRAFT_EXTRACTIONS_CORRUPT_BACKUP_STORAGE_KEY = "linkdish.draftRecipeExtractions.corrupt.v1";
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
): { drafts: DraftRecipeExtractionRecord[]; isCorrupt: boolean } => {
  if (!serializedDrafts) {
    return { drafts: [], isCorrupt: false };
  }

  try {
    const parsed = JSON.parse(serializedDrafts) as unknown;

    if (!Array.isArray(parsed)) {
      return { drafts: [], isCorrupt: true };
    }

    return {
      drafts: parsed
        .map(normalizeDraftRecipeExtractionRecord)
        .filter((entry): entry is DraftRecipeExtractionRecord => entry !== null),
      isCorrupt: false
    };
  } catch {
    return { drafts: [], isCorrupt: true };
  }
};

const readDraftRecipeExtractions = async (): Promise<DraftRecipeExtractionRecord[]> => {
  const serializedDrafts = await AsyncStorage.getItem(DRAFT_EXTRACTIONS_STORAGE_KEY);
  const { drafts, isCorrupt } = parseDraftRecipeExtractions(serializedDrafts);

  if (isCorrupt) {
    // The next save replaces this blob, so keep a copy of what could not be read
    // instead of discarding it outright.
    console.warn("Draft recipe extractions could not be read. Keeping a backup copy.");

    try {
      await AsyncStorage.setItem(
        DRAFT_EXTRACTIONS_CORRUPT_BACKUP_STORAGE_KEY,
        serializedDrafts ?? ""
      );
    } catch (error) {
      console.warn("Failed to back up the unreadable draft recipe extractions.", error);
    }
  }

  return drafts;
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
