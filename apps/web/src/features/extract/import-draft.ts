import { safeGetItem, safeRemoveItem, safeSetItem } from "../../platform/safe-storage";

import type { ImportRequest } from "./use-import-session";
import type { ExtractRecipeImage, ExtractRecipeSuccess } from "@linkdish/api-contracts";

/**
 * An imported recipe that hasn't been saved yet survives leaving the Add tab (or a reload) for
 * the rest of the browser session, so a spent import is never thrown away by accident.
 */

export const IMPORT_DRAFT_STORAGE_KEY = "linkdish:web:import-draft:v1";
/** Photos are only kept with the draft while they fit comfortably in session storage. */
const MAX_DRAFT_IMAGE_CHARS = 2_500_000;

export interface ImportDraft {
  version: 1;
  savedAt: string;
  correlationId: string;
  attempt: "primary" | "fallback";
  request: ImportRequest;
  response: ExtractRecipeSuccess;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const withinImageBudget = (images: readonly ExtractRecipeImage[]): boolean =>
  images.reduce((total, image) => total + image.dataUrl.length, 0) <= MAX_DRAFT_IMAGE_CHARS;

export const writeImportDraft = (draft: Omit<ImportDraft, "version" | "savedAt">): void => {
  const request: ImportRequest =
    draft.request.kind === "images" && !withinImageBudget(draft.request.images)
      ? { ...draft.request, images: [] }
      : draft.request;
  const value: ImportDraft = {
    ...draft,
    request,
    savedAt: new Date().toISOString(),
    version: 1
  };

  if (
    !safeSetItem(IMPORT_DRAFT_STORAGE_KEY, JSON.stringify(value), "session") &&
    request.kind === "images"
  ) {
    // Storage full: keep the recipe even if the photos can't come along.
    safeSetItem(
      IMPORT_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...value, request: { ...request, images: [] } }),
      "session"
    );
  }
};

export const readImportDraft = (): ImportDraft | null => {
  const raw = safeGetItem(IMPORT_DRAFT_STORAGE_KEY, "session");

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      typeof parsed.correlationId === "string" &&
      isRecord(parsed.request) &&
      isRecord(parsed.response) &&
      parsed.response.status === "success" &&
      isRecord(parsed.response.recipe) &&
      typeof parsed.response.recipe.title === "string"
    ) {
      return parsed as unknown as ImportDraft;
    }
  } catch {
    // A corrupt draft is simply dropped.
  }

  clearImportDraft();
  return null;
};

export const clearImportDraft = (): void => {
  safeRemoveItem(IMPORT_DRAFT_STORAGE_KEY, "session");
};
