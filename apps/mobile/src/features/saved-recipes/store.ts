import {
  createRecipeSearchIndex,
  isLikelySameRecipe,
  recipeSearchFields
} from "@linkdish/recipe-domain";

import type { RecipeSourceImage, SuccessfulExtractionState } from "../recipe-results/types";
import type {
  ExtractRecipeImage,
  SharedRecipe,
  UpsertSharedRecipeRequest
} from "@linkdish/api-contracts";
import type {
  RecipeImage,
  RecipeSearchFields,
  RecipeSearchIndex,
  StarterRecipeSeedRecord
} from "@linkdish/recipe-domain";

export type RecipeBookShareMode = "none" | "selected" | "all";

export interface SavedRecipeRecord {
  clonedFromId?: string | undefined;
  /** Hearted in the Cookbook. Added later: missing means false. */
  favorite?: boolean | undefined;
  fetchMode: SuccessfulExtractionState["fetchMode"];
  id: string;
  isStarter?: boolean | undefined;
  notes?: string | undefined;
  provenance: SuccessfulExtractionState["provenance"];
  recipe: SuccessfulExtractionState["recipe"];
  savedAt: string;
  sharedAt?: string | undefined;
  /**
   * The account that shared it (whose Family copy `sharedRecipeId` is). The cookbook on this
   * device is whoever signs in's, but a Family link is only that account's. Missing on links made
   * before it was recorded.
   */
  sharedByUserId?: string | undefined;
  sharedRecipeId?: string | undefined;
  sourceImages?: RecipeSourceImage[] | undefined;
  strategy: SuccessfulExtractionState["strategy"];
  timesCooked?: number | undefined;
  updatedAt?: string | undefined;
  warnings: SuccessfulExtractionState["warnings"];
}

export interface SavedRecipeUpdate {
  notes?: string | undefined;
  recipe?: SavedRecipeRecord["recipe"];
  updatedAt?: string | undefined;
}

export const createSavedRecipeId = (date = new Date()): string =>
  `saved-${date.getTime()}-${Math.random().toString(36).slice(2, 10)}`;

export const createSharedRecipeSourceId = (sourceUrl: string): string => {
  let hash = 2_166_136_261;

  for (let index = 0; index < sourceUrl.length; index += 1) {
    hash ^= sourceUrl.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }

  return `source-${hash.toString(36)}`;
};

export const normalizeSavedRecipeRecord = (value: unknown): SavedRecipeRecord | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    clonedFromId?: unknown;
    favorite?: unknown;
    id?: unknown;
    isStarter?: unknown;
    recipe?: {
      sourceUrl?: unknown;
      title?: unknown;
    };
    savedAt?: unknown;
    sharedAt?: unknown;
    sharedByUserId?: unknown;
    sharedRecipeId?: unknown;
    timesCooked?: unknown;
  };

  if (
    typeof candidate.savedAt !== "string" ||
    typeof candidate.recipe?.sourceUrl !== "string" ||
    typeof candidate.recipe.title !== "string"
  ) {
    return null;
  }

  const record = value as SavedRecipeRecord;
  const id =
    typeof candidate.id === "string" && candidate.id.trim().length > 0
      ? candidate.id
      : candidate.recipe.sourceUrl;
  const clonedFromId =
    typeof candidate.clonedFromId === "string" && candidate.clonedFromId.trim().length > 0
      ? candidate.clonedFromId
      : undefined;
  const sharedRecipeId =
    typeof candidate.sharedRecipeId === "string" && candidate.sharedRecipeId.trim().length > 0
      ? candidate.sharedRecipeId
      : undefined;
  const sharedAt =
    typeof candidate.sharedAt === "string" && candidate.sharedAt.trim().length > 0
      ? candidate.sharedAt
      : undefined;
  const sharedByUserId =
    sharedRecipeId &&
    typeof candidate.sharedByUserId === "string" &&
    candidate.sharedByUserId.trim().length > 0
      ? candidate.sharedByUserId
      : undefined;
  const timesCooked =
    typeof candidate.timesCooked === "number" &&
    Number.isFinite(candidate.timesCooked) &&
    candidate.timesCooked >= 0
      ? Math.floor(candidate.timesCooked)
      : 0;

  return {
    ...record,
    clonedFromId,
    // Only `true` is kept, so records written before favorites existed read back unchanged.
    favorite: candidate.favorite === true ? true : undefined,
    id,
    ...(candidate.isStarter === true ? { isStarter: true } : {}),
    recipe: {
      ...record.recipe,
      image: normalizeRecipeImage((record.recipe as { image?: unknown }).image)
    },
    sharedAt,
    sharedByUserId,
    sharedRecipeId,
    sourceImages: normalizeSourceImages((record as { sourceImages?: unknown }).sourceImages),
    timesCooked
  };
};

const recipeImageSources = new Set<RecipeImage["source"]>([
  "content",
  "jsonld",
  "og",
  "twitter",
  "youtube-thumb"
]);

const normalizeRecipeImage = (value: unknown): RecipeImage | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    height?: unknown;
    source?: unknown;
    url?: unknown;
    width?: unknown;
  };

  if (
    typeof candidate.url !== "string" ||
    !candidate.url.trim() ||
    !recipeImageSources.has(candidate.source as RecipeImage["source"])
  ) {
    return null;
  }

  return {
    url: candidate.url,
    width:
      typeof candidate.width === "number" && Number.isFinite(candidate.width)
        ? candidate.width
        : null,
    height:
      typeof candidate.height === "number" && Number.isFinite(candidate.height)
        ? candidate.height
        : null,
    source: candidate.source as RecipeImage["source"]
  };
};

export const isDataUrlSourceImage = (image: RecipeSourceImage): boolean =>
  image.uri.startsWith("data:");

const isSupportedSourceImageMimeType = (value: unknown): value is ExtractRecipeImage["mimeType"] =>
  value === "image/jpeg" || value === "image/png" || value === "image/webp";

/**
 * Reads a persisted scan photo entry.
 *
 * Accepts both the current `{ uri }` shape and the legacy `{ dataUrl }` shape so
 * cookbooks written by older builds keep their scans until they are migrated to
 * the filesystem.
 */
const normalizeSourceImages = (value: unknown): RecipeSourceImage[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const images = value
    .map((image): RecipeSourceImage | null => {
      if (!image || typeof image !== "object") {
        return null;
      }

      const candidate = image as { dataUrl?: unknown; mimeType?: unknown; uri?: unknown };

      if (!isSupportedSourceImageMimeType(candidate.mimeType)) {
        return null;
      }

      if (typeof candidate.uri === "string" && candidate.uri.trim().length > 0) {
        return {
          mimeType: candidate.mimeType,
          uri: candidate.uri
        };
      }

      if (typeof candidate.dataUrl === "string" && candidate.dataUrl.startsWith("data:image/")) {
        return {
          mimeType: candidate.mimeType,
          uri: candidate.dataUrl
        };
      }

      return null;
    })
    .filter((image): image is RecipeSourceImage => image !== null);

  return images.length > 0 ? images : undefined;
};

export const createSavedRecipeRecord = (
  state: SuccessfulExtractionState,
  savedAt = new Date().toISOString()
): SavedRecipeRecord => ({
  fetchMode: state.fetchMode,
  id: createSavedRecipeId(new Date(savedAt)),
  provenance: state.provenance,
  recipe: state.recipe,
  savedAt,
  sourceImages: state.sourceImages,
  strategy: state.strategy,
  timesCooked: 0,
  warnings: state.warnings
});

export const starterRecipeSeedRecordToSavedRecipeRecord = (
  seedRecord: StarterRecipeSeedRecord
): SavedRecipeRecord => ({
  fetchMode: seedRecord.fetchMode,
  id: seedRecord.id,
  isStarter: true,
  provenance: seedRecord.provenance,
  recipe: seedRecord.recipe,
  savedAt: seedRecord.savedAt,
  strategy: seedRecord.strategy,
  timesCooked: 0,
  warnings: seedRecord.warnings
});

export const getQuotaSavedRecipeCount = (savedRecipes: SavedRecipeRecord[]): number =>
  savedRecipes.filter((entry) => !entry.isStarter).length;

export const restoreSavedRecipeState = (
  savedRecipe: SavedRecipeRecord
): SuccessfulExtractionState => ({
  state: "success",
  fetchMode: savedRecipe.fetchMode,
  provenance: savedRecipe.provenance,
  recipe: savedRecipe.recipe,
  sourceImages: savedRecipe.sourceImages,
  strategy: savedRecipe.strategy,
  warnings: savedRecipe.warnings
});

export const upsertSavedRecipeRecord = (
  savedRecipes: SavedRecipeRecord[],
  savedRecipe: SavedRecipeRecord
): SavedRecipeRecord[] => [
  savedRecipe,
  ...savedRecipes.filter(
    (entry) =>
      entry.id !== savedRecipe.id &&
      (entry.clonedFromId != null || entry.recipe.sourceUrl !== savedRecipe.recipe.sourceUrl)
  )
];

export const getSavedRecipeRecordById = (
  savedRecipes: SavedRecipeRecord[],
  id: string
): SavedRecipeRecord | undefined => savedRecipes.find((entry) => entry.id === id);

/**
 * The saved recipe for a source URL: an exact match first (the original before any copy),
 * then the same page written differently (tracking parameters, www./m./AMP variants, a
 * trailing slash, a youtu.be vs watch link) via the domain's isLikelySameRecipe. This is the
 * duplicate check the import flows rely on, so pasting a tracked link to a recipe that is
 * already saved opens it instead of spending an import.
 */
export const getSavedRecipeRecordBySourceUrl = (
  savedRecipes: SavedRecipeRecord[],
  sourceUrl: string
): SavedRecipeRecord | undefined =>
  savedRecipes.find(
    (entry) => entry.recipe.sourceUrl === sourceUrl && entry.clonedFromId == null
  ) ??
  savedRecipes.find((entry) => entry.recipe.sourceUrl === sourceUrl) ??
  savedRecipes.find(
    (entry) => entry.clonedFromId == null && isLikelySameRecipe(entry.recipe.sourceUrl, sourceUrl)
  );

export const removeSavedRecipeRecord = (
  savedRecipes: SavedRecipeRecord[],
  id: string
): SavedRecipeRecord[] => savedRecipes.filter((entry) => entry.id !== id);

export const updateSavedRecipeRecord = (
  savedRecipes: SavedRecipeRecord[],
  id: string,
  update: SavedRecipeUpdate
): SavedRecipeRecord[] =>
  savedRecipes.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }

    return {
      ...entry,
      notes: update.notes,
      recipe: update.recipe ?? entry.recipe,
      updatedAt: update.updatedAt ?? new Date().toISOString()
    };
  });

const copyRecipe = (recipe: SavedRecipeRecord["recipe"]): SavedRecipeRecord["recipe"] => ({
  ...recipe,
  confidence: {
    ...recipe.confidence,
    fieldProvenance: {
      ...recipe.confidence.fieldProvenance
    },
    missingFields: [...recipe.confidence.missingFields],
    notes: [...recipe.confidence.notes]
  },
  image: recipe.image ?? null,
  ingredients: recipe.ingredients.map((ingredient) => ({ ...ingredient })),
  nutrition: recipe.nutrition ? { ...recipe.nutrition } : null,
  steps: recipe.steps.map((step) => ({ ...step }))
});

const getCloneTitle = (savedRecipes: SavedRecipeRecord[], title: string): string => {
  const existingTitles = new Set(savedRecipes.map((entry) => entry.recipe.title));
  const baseTitle = title.trim();
  const firstCopyTitle = `${baseTitle} (Copy)`;

  if (!existingTitles.has(firstCopyTitle)) {
    return firstCopyTitle;
  }

  for (let copyNumber = 2; ; copyNumber += 1) {
    const nextTitle = `${baseTitle} (Copy ${copyNumber})`;

    if (!existingTitles.has(nextTitle)) {
      return nextTitle;
    }
  }
};

export const cloneSavedRecipeRecord = (
  savedRecipes: SavedRecipeRecord[],
  sourceRecord: SavedRecipeRecord,
  clonedAt = new Date().toISOString()
): SavedRecipeRecord => {
  const recipe = copyRecipe(sourceRecord.recipe);

  return {
    ...sourceRecord,
    clonedFromId: sourceRecord.id,
    favorite: undefined,
    id: createSavedRecipeId(new Date(clonedAt)),
    isStarter: undefined,
    notes: sourceRecord.notes,
    recipe: {
      ...recipe,
      title: getCloneTitle(savedRecipes, sourceRecord.recipe.title)
    },
    savedAt: clonedAt,
    sharedAt: undefined,
    sharedByUserId: undefined,
    sharedRecipeId: undefined,
    sourceImages: sourceRecord.sourceImages?.map((image) => ({ ...image })),
    timesCooked: 0,
    updatedAt: undefined
  };
};

export const savedRecipeRecordToSharedRecipeRequest = (
  record: SavedRecipeRecord
): UpsertSharedRecipeRequest => ({
  fetchMode: record.fetchMode,
  notes: record.notes,
  provenance: record.provenance as UpsertSharedRecipeRequest["provenance"],
  recipe: record.recipe,
  sourceSavedRecipeId:
    record.clonedFromId == null ? createSharedRecipeSourceId(record.recipe.sourceUrl) : record.id,
  strategy: record.strategy as UpsertSharedRecipeRequest["strategy"],
  warnings: record.warnings
});

export const successStateToSharedRecipeRequest = (
  state: SuccessfulExtractionState
): UpsertSharedRecipeRequest => ({
  fetchMode: state.fetchMode,
  provenance: state.provenance as UpsertSharedRecipeRequest["provenance"],
  recipe: state.recipe,
  sourceSavedRecipeId: createSharedRecipeSourceId(state.recipe.sourceUrl),
  strategy: state.strategy as UpsertSharedRecipeRequest["strategy"],
  warnings: state.warnings
});

export const sharedRecipeToSavedRecipeRecord = (sharedRecipe: SharedRecipe): SavedRecipeRecord => ({
  fetchMode: sharedRecipe.fetchMode,
  id: sharedRecipe.id,
  notes: sharedRecipe.notes,
  provenance: sharedRecipe.provenance,
  recipe: sharedRecipe.recipe,
  savedAt: sharedRecipe.createdAt,
  sharedAt: sharedRecipe.updatedAt,
  sharedByUserId: sharedRecipe.ownerUserId,
  sharedRecipeId: sharedRecipe.id,
  strategy: sharedRecipe.strategy,
  timesCooked: 0,
  updatedAt: sharedRecipe.updatedAt,
  warnings: sharedRecipe.warnings
});

export const incrementSavedRecipeTimesCooked = (
  savedRecipes: SavedRecipeRecord[],
  savedRecipeId: string
): SavedRecipeRecord[] =>
  savedRecipes.map((entry) =>
    entry.id === savedRecipeId
      ? {
          ...entry,
          timesCooked: (entry.timesCooked ?? 0) + 1
        }
      : entry
  );

export const setSavedRecipeFavorite = (
  savedRecipes: SavedRecipeRecord[],
  savedRecipeId: string,
  favorite: boolean
): SavedRecipeRecord[] =>
  savedRecipes.map((entry) =>
    entry.id === savedRecipeId ? { ...entry, favorite: favorite ? true : undefined } : entry
  );

const RECIPE_SCAN_DIRECTORY_SEGMENT = "/recipe-scans/";

/**
 * Scan files that only the removed records used. Clones copy their source's scan URIs, so a
 * file still referenced by any remaining record is kept; only app-owned files in the
 * recipe-scans directory are ever returned.
 */
export const getOrphanedSourceImageUris = (
  remainingRecipes: SavedRecipeRecord[],
  removedRecipes: SavedRecipeRecord[]
): string[] => {
  const stillReferenced = new Set(
    remainingRecipes.flatMap((entry) => entry.sourceImages?.map((image) => image.uri) ?? [])
  );
  const orphaned = new Set<string>();

  for (const entry of removedRecipes) {
    for (const image of entry.sourceImages ?? []) {
      if (
        image.uri.startsWith("file:") &&
        image.uri.includes(RECIPE_SCAN_DIRECTORY_SEGMENT) &&
        !stillReferenced.has(image.uri)
      ) {
        orphaned.add(image.uri);
      }
    }
  }

  return [...orphaned];
};

export const getSharedRecipeOwnerLabel = (
  sharedRecipe: Pick<SharedRecipe, "ownerAvatarEmoji" | "ownerDisplayName" | "ownerEmail">
): string => {
  const name = sharedRecipe.ownerDisplayName?.trim() || sharedRecipe.ownerEmail;

  return sharedRecipe.ownerAvatarEmoji ? `${sharedRecipe.ownerAvatarEmoji} ${name}` : name;
};

export const markSavedRecipeShared = (
  savedRecipes: SavedRecipeRecord[],
  savedRecipeId: string,
  sharedRecipe: SharedRecipe
): SavedRecipeRecord[] =>
  savedRecipes.map((entry) =>
    entry.id === savedRecipeId
      ? {
          ...entry,
          sharedAt: sharedRecipe.updatedAt,
          sharedByUserId: sharedRecipe.ownerUserId,
          sharedRecipeId: sharedRecipe.id
        }
      : entry
  );

export const markSavedRecipeUnshared = (
  savedRecipes: SavedRecipeRecord[],
  savedRecipeId: string
): SavedRecipeRecord[] =>
  savedRecipes.map((entry) =>
    entry.id === savedRecipeId
      ? {
          ...entry,
          sharedAt: undefined,
          sharedByUserId: undefined,
          sharedRecipeId: undefined
        }
      : entry
  );

/**
 * The Family copy `record` links to, when that link is `userId`'s to use: it shared it, or (a link
 * from before sharers were recorded) that account's Family list has the copy as its own. Another
 * account's link on this device is not this one's to update or unshare. Sharing a recipe whose
 * old link isn't known to be the account's is safe: the API keys copies by sharer and recipe, so
 * the account that shared it gets its own copy back, updated, and any other one a copy of its own.
 */
export const getOwnSharedRecipeId = (
  record: Pick<SavedRecipeRecord, "sharedByUserId" | "sharedRecipeId">,
  userId: string | null | undefined,
  familyRecipes: readonly Pick<SharedRecipe, "id" | "ownerUserId">[] | null
): string | undefined => {
  if (!record.sharedRecipeId || !userId) {
    return undefined;
  }

  if (record.sharedByUserId) {
    return record.sharedByUserId === userId ? record.sharedRecipeId : undefined;
  }

  // From before sharers were recorded: nobody's until the account's Family list shows whose copy
  // it is (recordSharedLinkOwners then stores that).
  const copy = familyRecipes?.find((entry) => entry.id === record.sharedRecipeId);
  return copy?.ownerUserId === userId ? record.sharedRecipeId : undefined;
};

/**
 * `records` with the sharer recorded on each link made before sharers were recorded whose copy
 * `familyRecipes` (an account's Family list) shows, so those links read right without the list.
 * Links to copies it doesn't list stay nobody's. The same array when there is nothing to record.
 */
export const recordSharedLinkOwners = <Entry extends SavedRecipeRecord>(
  records: Entry[],
  familyRecipes: readonly Pick<SharedRecipe, "id" | "ownerUserId">[]
): Entry[] => {
  const owners = new Map(familyRecipes.map((entry) => [entry.id, entry.ownerUserId]));
  let changed = false;
  const next = records.map((record) => {
    const owner =
      record.sharedRecipeId && !record.sharedByUserId
        ? owners.get(record.sharedRecipeId)
        : undefined;

    if (!owner) {
      return record;
    }

    changed = true;
    return { ...record, sharedByUserId: owner };
  });

  return changed ? next : records;
};

/**
 * `record` as signed-in `userId` sees it: another account's Family link on it reads as not
 * shared. Signed out, it reads as stored (nothing can be shared or unshared then).
 */
export const withOwnSharedLink = <Entry extends SavedRecipeRecord>(
  record: Entry,
  userId: string | null | undefined,
  familyRecipes: readonly Pick<SharedRecipe, "id" | "ownerUserId">[] | null
): Entry =>
  !userId || !record.sharedRecipeId || getOwnSharedRecipeId(record, userId, familyRecipes)
    ? record
    : { ...record, sharedAt: undefined, sharedByUserId: undefined, sharedRecipeId: undefined };

const textListOf = <T>(value: unknown, read: (entry: T) => unknown): string[] =>
  Array.isArray(value)
    ? (value as T[]).flatMap((entry) => {
        const text = entry == null ? undefined : read(entry);
        return typeof text === "string" ? [text] : [];
      })
    : [];

/**
 * Searchable fields for any record carrying a recipe (saved or shared). Stored cookbooks were
 * written by many app versions, so every field is read defensively.
 */
export const recipeRecordSearchFields = (record: {
  notes?: string | null | undefined;
  recipe: SavedRecipeRecord["recipe"];
}): RecipeSearchFields => {
  const recipe = record.recipe as Partial<SavedRecipeRecord["recipe"]> | undefined;

  return recipeSearchFields(
    {
      ...(Array.isArray(recipe?.keywords) ? { keywords: recipe.keywords } : {}),
      ...(typeof recipe?.cuisine === "string" ? { cuisine: recipe.cuisine } : {}),
      ...(typeof recipe?.category === "string" ? { category: recipe.category } : {}),
      ...(typeof recipe?.author === "string" ? { author: recipe.author } : {}),
      ...(typeof recipe?.siteName === "string" ? { siteName: recipe.siteName } : {}),
      ingredients: textListOf<{ text?: unknown }>(recipe?.ingredients, (entry) => entry.text).map(
        (text) => ({ text })
      ),
      sourceUrl: typeof recipe?.sourceUrl === "string" ? recipe.sourceUrl : "",
      steps: textListOf<{ text?: unknown }>(recipe?.steps, (entry) => entry.text).map(
        (text, index) => ({ index: index + 1, text })
      ),
      title: typeof recipe?.title === "string" ? recipe.title : ""
    },
    { notes: typeof record.notes === "string" ? record.notes : null }
  );
};

/**
 * The domain search index over a cookbook. Build it once per library change (the Cookbook
 * memoizes it on `savedRecipes`) and query it on every keystroke.
 */
export const buildSavedRecipeSearchIndex = (
  savedRecipes: readonly SavedRecipeRecord[]
): RecipeSearchIndex<SavedRecipeRecord> =>
  createRecipeSearchIndex(savedRecipes, recipeRecordSearchFields);

export const buildSharedRecipeSearchIndex = (
  sharedRecipes: readonly SharedRecipe[]
): RecipeSearchIndex<SharedRecipe> =>
  createRecipeSearchIndex(sharedRecipes, recipeRecordSearchFields);

/** Ranked matches; every query word must match (title > tags > ingredients > source/notes > steps). */
export const searchSavedRecipeRecords = (
  savedRecipes: SavedRecipeRecord[],
  query: string
): SavedRecipeRecord[] =>
  query.trim()
    ? buildSavedRecipeSearchIndex(savedRecipes)
        .search(query)
        .map((result) => result.record)
    : savedRecipes;

export const searchSharedRecipeRecords = (
  sharedRecipes: SharedRecipe[],
  query: string
): SharedRecipe[] =>
  query.trim()
    ? buildSharedRecipeSearchIndex(sharedRecipes)
        .search(query)
        .map((result) => result.record)
    : sharedRecipes;

export type SavedRecipeReadStatus = "corrupt" | "empty" | "ok";

export interface SavedRecipeReadResult {
  records: SavedRecipeRecord[];
  status: SavedRecipeReadStatus;
}

/**
 * Reads the persisted cookbook and reports whether the blob itself was readable.
 *
 * A `corrupt` status means the whole blob could not be understood, which is very
 * different from an empty cookbook: callers must not persist over a corrupt blob
 * (that turns a recoverable read failure into permanent data loss).
 */
export const readSavedRecipeRecords = (
  serializedSavedRecipes: string | null
): SavedRecipeReadResult => {
  if (!serializedSavedRecipes) {
    return { records: [], status: "empty" };
  }

  try {
    const parsed = JSON.parse(serializedSavedRecipes) as unknown;

    if (!Array.isArray(parsed)) {
      return { records: [], status: "corrupt" };
    }

    return {
      records: parsed
        .map(normalizeSavedRecipeRecord)
        .filter((entry): entry is SavedRecipeRecord => entry !== null),
      status: "ok"
    };
  } catch {
    return { records: [], status: "corrupt" };
  }
};

export const parseSavedRecipeRecords = (
  serializedSavedRecipes: string | null
): SavedRecipeRecord[] => readSavedRecipeRecords(serializedSavedRecipes).records;

/**
 * Drops scan photos that are still `data:` URLs.
 *
 * Base64 scans are megabytes each and a single oversized AsyncStorage write
 * fails on Android, which used to silently drop the whole cookbook. Scans are
 * written to the filesystem before a save; anything still inlined here could not
 * be written to disk and is not worth losing the cookbook over.
 */
const stripUnpersistableSourceImages = (record: SavedRecipeRecord): SavedRecipeRecord => {
  if (!record.sourceImages?.some(isDataUrlSourceImage)) {
    return record;
  }

  const persistableImages = record.sourceImages.filter((image) => !isDataUrlSourceImage(image));

  return {
    ...record,
    sourceImages: persistableImages.length > 0 ? persistableImages : undefined
  };
};

export const serializeSavedRecipeRecords = (savedRecipes: SavedRecipeRecord[]): string =>
  JSON.stringify(savedRecipes.map(stripUnpersistableSourceImages));
