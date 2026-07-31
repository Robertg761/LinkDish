import type { SuccessfulExtractionState } from "../recipe-results/types";
import type {
  ExtractRecipeImage,
  SharedRecipe,
  UpsertSharedRecipeRequest
} from "@linkdish/api-contracts";
import type { RecipeImage, StarterRecipeSeedRecord } from "@linkdish/recipe-domain";

export type RecipeBookShareMode = "none" | "selected" | "all";

export interface SavedRecipeRecord {
  clonedFromId?: string | undefined;
  fetchMode: SuccessfulExtractionState["fetchMode"];
  id: string;
  isStarter?: boolean | undefined;
  notes?: string | undefined;
  provenance: SuccessfulExtractionState["provenance"];
  recipe: SuccessfulExtractionState["recipe"];
  savedAt: string;
  sharedAt?: string | undefined;
  sharedRecipeId?: string | undefined;
  sourceImages?: ExtractRecipeImage[] | undefined;
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

interface SavedRecipeSearchIndexEntry {
  haystack: string;
  ingredients: string;
  notes: string;
  record: SavedRecipeRecord;
  source: string;
  steps: string;
  title: string;
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
    id?: unknown;
    isStarter?: unknown;
    recipe?: {
      sourceUrl?: unknown;
      title?: unknown;
    };
    savedAt?: unknown;
    sharedAt?: unknown;
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
  const timesCooked =
    typeof candidate.timesCooked === "number" &&
    Number.isFinite(candidate.timesCooked) &&
    candidate.timesCooked >= 0
      ? Math.floor(candidate.timesCooked)
      : 0;

  return {
    ...record,
    clonedFromId,
    id,
    ...(candidate.isStarter === true ? { isStarter: true } : {}),
    recipe: {
      ...record.recipe,
      image: normalizeRecipeImage((record.recipe as { image?: unknown }).image)
    },
    sharedAt,
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

const normalizeSourceImages = (value: unknown): ExtractRecipeImage[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const images = value
    .filter((image): image is { dataUrl: string; mimeType: ExtractRecipeImage["mimeType"] } => {
      if (!image || typeof image !== "object") {
        return false;
      }

      const candidate = image as { dataUrl?: unknown; mimeType?: unknown };

      return (
        typeof candidate.dataUrl === "string" &&
        candidate.dataUrl.startsWith("data:image/") &&
        (candidate.mimeType === "image/jpeg" ||
          candidate.mimeType === "image/png" ||
          candidate.mimeType === "image/webp")
      );
    })
    .map((image) => ({
      dataUrl: image.dataUrl,
      mimeType: image.mimeType
    }));

  return images.length > 0 ? images : undefined;
};

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();

const getRecipeSourceLabel = (sourceUrl: string): string => {
  if (sourceUrl.includes("linkdish.app/image-imports/")) {
    return "Scanned image";
  }

  try {
    return new URL(sourceUrl).hostname.replace(/^www\./u, "");
  } catch {
    return sourceUrl;
  }
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

export const getSavedRecipeRecordBySourceUrl = (
  savedRecipes: SavedRecipeRecord[],
  sourceUrl: string
): SavedRecipeRecord | undefined =>
  savedRecipes.find(
    (entry) => entry.recipe.sourceUrl === sourceUrl && entry.clonedFromId == null
  ) ?? savedRecipes.find((entry) => entry.recipe.sourceUrl === sourceUrl);

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
    id: createSavedRecipeId(new Date(clonedAt)),
    isStarter: undefined,
    notes: sourceRecord.notes,
    recipe: {
      ...recipe,
      title: getCloneTitle(savedRecipes, sourceRecord.recipe.title)
    },
    savedAt: clonedAt,
    sharedAt: undefined,
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
          sharedRecipeId: undefined
        }
      : entry
  );

export const buildSavedRecipeSearchIndex = (
  savedRecipes: SavedRecipeRecord[]
): SavedRecipeSearchIndexEntry[] =>
  savedRecipes.map((record) => {
    const title = normalizeSearchText(record.recipe.title);
    const source = normalizeSearchText(getRecipeSourceLabel(record.recipe.sourceUrl));
    const servings = normalizeSearchText(record.recipe.servings ?? "");
    const ingredients = normalizeSearchText(
      record.recipe.ingredients.map((ingredient) => ingredient.text).join(" ")
    );
    const steps = normalizeSearchText(record.recipe.steps.map((step) => step.text).join(" "));
    const notes = normalizeSearchText(record.notes ?? "");
    const haystack = [title, source, servings, ingredients, steps, notes].join(" ");

    return {
      haystack,
      ingredients,
      notes,
      record,
      source,
      steps,
      title
    };
  });

export const searchSavedRecipeRecords = (
  savedRecipes: SavedRecipeRecord[],
  query: string
): SavedRecipeRecord[] => {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);

  if (tokens.length === 0) {
    return savedRecipes;
  }

  return buildSavedRecipeSearchIndex(savedRecipes)
    .map((entry) => {
      const matches = tokens.every((token) => entry.haystack.includes(token));

      if (!matches) {
        return null;
      }

      const score = tokens.reduce((total, token) => {
        if (entry.title.includes(token)) {
          return total + 8;
        }

        if (entry.source.includes(token)) {
          return total + 5;
        }

        if (entry.ingredients.includes(token)) {
          return total + 4;
        }

        if (entry.notes.includes(token)) {
          return total + 3;
        }

        if (entry.steps.includes(token)) {
          return total + 2;
        }

        return total + 1;
      }, 0);

      return {
        record: entry.record,
        score
      };
    })
    .filter((entry): entry is { record: SavedRecipeRecord; score: number } => entry !== null)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.record);
};

export const searchSharedRecipeRecords = (
  sharedRecipes: SharedRecipe[],
  query: string
): SharedRecipe[] => {
  const byId = new Map(sharedRecipes.map((recipe) => [recipe.id, recipe]));

  return searchSavedRecipeRecords(sharedRecipes.map(sharedRecipeToSavedRecipeRecord), query)
    .map((record) => byId.get(record.id))
    .filter((recipe): recipe is SharedRecipe => recipe != null);
};

export const parseSavedRecipeRecords = (
  serializedSavedRecipes: string | null
): SavedRecipeRecord[] => {
  if (!serializedSavedRecipes) {
    return [];
  }

  try {
    const parsed = JSON.parse(serializedSavedRecipes) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(normalizeSavedRecipeRecord)
      .filter((entry): entry is SavedRecipeRecord => entry !== null);
  } catch {
    return [];
  }
};

export const serializeSavedRecipeRecords = (savedRecipes: SavedRecipeRecord[]): string =>
  JSON.stringify(savedRecipes);
