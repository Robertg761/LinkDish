import {
  extractionProvenanceSchema,
  extractionStrategySchema,
  fetchModeSchema,
  MAX_LIBRARY_COLLECTION_DESCRIPTION_LENGTH,
  MAX_LIBRARY_COLLECTION_EMOJI_LENGTH,
  MAX_LIBRARY_COLLECTION_NAME_LENGTH,
  MAX_LIBRARY_COOK_LOG_ENTRIES,
  MAX_LIBRARY_COOK_LOG_NOTE_LENGTH
} from "@linkdish/api-contracts";
import {
  canonicalizeRecipeUrl,
  createLinkDishBackup,
  MAX_BACKUP_NOTES_LENGTH,
  MAX_BACKUP_TAG_LENGTH,
  MAX_BACKUP_TAGS,
  MAX_MEAL_PLAN_NOTE_LENGTH,
  MAX_MEAL_PLAN_SERVINGS,
  SAMPLE_RECIPES
} from "@linkdish/recipe-domain";

import { isMealPlanSlot } from "../meal-plan/store";
import {
  getRecipeCollectionIds,
  getRecipeTags,
  normalizeRecipeTags
} from "../saved-recipes/collections";

import type { MealPlanEntry } from "../meal-plan/store";
import type { MobileCollection } from "../saved-recipes/collections";
import type { SavedRecipeLibraryExtras, SavedRecipeRecord } from "../saved-recipes/store";
import type {
  BackupCollection,
  BackupRecipe,
  LinkDishBackup,
  MealPlanEntry as BackupMealPlanEntry
} from "@linkdish/recipe-domain";

/**
 * Backing up and restoring the cookbook as a LinkDish backup file, the same versioned format the
 * web app writes (see `linkdishBackupSchema` in recipe-domain), so a file made on either restores
 * on the other.
 *
 * What the shared format has no field for (collection emoji and order, how a recipe was
 * extracted, preferred servings, when a planned meal was added) travels in the web app's extras
 * field, {@link BACKUP_EXTRAS_KEY}, which both apps read and anything else ignores.
 */

export const BACKUP_EXTRAS_KEY = "linkdishWeb";
export const BACKUP_EXTRAS_VERSION = 1;
export const BACKUP_APP_LABEL = "LinkDish Android";

const MAX_EXTRACTION_PROVENANCE = 12;
const MAX_EXTRACTION_WARNINGS = 50;
const MAX_EXTRACTION_WARNING_LENGTH = 500;
const MAX_MEAL_TITLE_LENGTH = 200;
const MAX_MEAL_NOTE_LENGTH = 500;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/u;
const STARTER_IDS: ReadonlySet<string> = new Set(SAMPLE_RECIPES.map((sample) => sample.id));

type Extraction = Pick<SavedRecipeRecord, "fetchMode" | "provenance" | "strategy" | "warnings">;

export interface BackupRecipeExtras {
  extraction?: Extraction | undefined;
  lastCookedAt?: string | undefined;
  preferredServings?: number | undefined;
}

export interface BackupCollectionExtras {
  description?: string | undefined;
  emoji?: string | undefined;
  sortOrder?: number | undefined;
}

export interface BackupExtras {
  version: typeof BACKUP_EXTRAS_VERSION;
  recipes: Record<string, BackupRecipeExtras>;
  collections: Record<string, BackupCollectionExtras>;
  mealPlan: Record<string, { createdAt?: string | undefined }>;
}

export type MobileLinkDishBackup = LinkDishBackup & { [BACKUP_EXTRAS_KEY]: BackupExtras };

/* ------------------------------------------------------------------------------------------------
 * Export
 * ---------------------------------------------------------------------------------------------- */

/** Whether a recipe carries anything personal, so a starter is worth backing up. */
const isPersonalized = (record: SavedRecipeRecord): boolean => {
  const extras = record.libraryExtras;

  return Boolean(
    record.favorite ||
    extras?.tags?.length ||
    extras?.collectionIds?.length ||
    extras?.rating ||
    record.notes?.trim() ||
    extras?.cookLog?.length ||
    (record.timesCooked ?? 0) > 0 ||
    extras?.preferredServings ||
    (record.updatedAt && record.updatedAt !== record.savedAt)
  );
};

/** Personal recipes, plus starters someone made their own (an untouched one comes back anyway). */
export const selectBackupRecipes = (records: readonly SavedRecipeRecord[]): SavedRecipeRecord[] =>
  records.filter((record) => !record.isStarter || isPersonalized(record));

const toBackupRecipe = (record: SavedRecipeRecord): BackupRecipe => {
  const notes = record.notes?.trim();
  const extras = record.libraryExtras;
  const tags = getRecipeTags(record)
    .map((tag) => tag.trim().slice(0, MAX_BACKUP_TAG_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_BACKUP_TAGS);
  const cookLog = (extras?.cookLog ?? []).map((entry) => ({
    cookedAt: entry.cookedAt,
    ...(entry.note?.trim() ? { note: entry.note.trim() } : {})
  }));

  return {
    id: record.id,
    recipe: record.recipe,
    meta: {
      ...(record.favorite ? { favorite: true } : {}),
      ...(tags.length ? { tags } : {}),
      ...(extras?.rating ? { rating: extras.rating } : {}),
      ...(notes ? { notes: notes.slice(0, MAX_BACKUP_NOTES_LENGTH) } : {}),
      timesCooked: Math.max(0, Math.round(record.timesCooked ?? 0)),
      ...(cookLog.length ? { cookLog } : {}),
      createdAt: record.savedAt,
      updatedAt: record.updatedAt ?? record.savedAt,
      sourceUrl: record.recipe.sourceUrl
    }
  };
};

const toRecipeExtras = (record: SavedRecipeRecord): BackupRecipeExtras => ({
  extraction: {
    fetchMode: record.fetchMode,
    provenance: record.provenance.slice(0, MAX_EXTRACTION_PROVENANCE),
    strategy: record.strategy,
    warnings: record.warnings
      .slice(0, MAX_EXTRACTION_WARNINGS)
      .map((warning) => warning.slice(0, MAX_EXTRACTION_WARNING_LENGTH))
  },
  ...(record.libraryExtras?.lastCookedAt
    ? { lastCookedAt: record.libraryExtras.lastCookedAt }
    : {}),
  ...(record.libraryExtras?.preferredServings &&
  record.libraryExtras.preferredServings <= MAX_MEAL_PLAN_SERVINGS
    ? { preferredServings: record.libraryExtras.preferredServings }
    : {})
});

const toBackupMealPlanEntry = (entry: MealPlanEntry): BackupMealPlanEntry => ({
  id: entry.id,
  date: entry.date,
  slot: entry.slot,
  title: entry.title,
  ...(entry.recipeId ? { recipeId: entry.recipeId } : {}),
  ...(entry.servings && entry.servings <= MAX_MEAL_PLAN_SERVINGS
    ? { servings: entry.servings }
    : {}),
  ...(entry.note ? { note: entry.note.slice(0, MAX_MEAL_PLAN_NOTE_LENGTH) } : {}),
  updatedAt: entry.updatedAt
});

/** The backup file's contents. Pure: the time is passed in. */
export const buildMobileBackup = (input: {
  collections: readonly MobileCollection[];
  exportedAt: string;
  mealPlan: readonly MealPlanEntry[];
  records: readonly SavedRecipeRecord[];
}): { backup: MobileLinkDishBackup; recipeCount: number } => {
  const records = selectBackupRecipes(input.records);
  const extras: BackupExtras = {
    version: BACKUP_EXTRAS_VERSION,
    recipes: Object.fromEntries(records.map((record) => [record.id, toRecipeExtras(record)])),
    collections: {},
    mealPlan: Object.fromEntries(
      input.mealPlan.map((entry) => [entry.id, { createdAt: entry.createdAt }])
    )
  };
  const collections: BackupCollection[] = input.collections.map((collection) => {
    extras.collections[collection.id] = {
      sortOrder: Math.max(0, Math.round(collection.sortOrder)),
      ...(collection.emoji ? { emoji: collection.emoji } : {}),
      ...(collection.description ? { description: collection.description } : {})
    };

    return {
      id: collection.id,
      name: collection.name,
      recipeIds: records
        .filter((record) => getRecipeCollectionIds(record).includes(collection.id))
        .map((record) => record.id),
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt
    };
  });

  return {
    backup: {
      ...createLinkDishBackup({
        app: BACKUP_APP_LABEL,
        collections,
        exportedAt: input.exportedAt,
        mealPlan: input.mealPlan.map(toBackupMealPlanEntry),
        recipes: records.map(toBackupRecipe)
      }),
      [BACKUP_EXTRAS_KEY]: extras
    },
    recipeCount: records.length
  };
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** "linkdish-backup-2026-10-26.json" (the device's date), as the web app names it. */
export const backupFileName = (date: Date): string =>
  `linkdish-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;

/* ------------------------------------------------------------------------------------------------
 * Reading the extras
 * ---------------------------------------------------------------------------------------------- */

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isDateTime = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const readExtraction = (value: unknown): Extraction | undefined => {
  const raw = recordOf(value);
  const fetchMode = fetchModeSchema.safeParse(raw.fetchMode);
  const strategy = extractionStrategySchema.safeParse(raw.strategy);
  const provenance = Array.isArray(raw.provenance)
    ? raw.provenance.flatMap((entry) => {
        const parsed = extractionProvenanceSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings
        .filter((warning): warning is string => typeof warning === "string")
        .slice(0, MAX_EXTRACTION_WARNINGS)
    : [];

  return fetchMode.success && strategy.success && provenance.length > 0
    ? { fetchMode: fetchMode.data, provenance, strategy: strategy.data, warnings }
    : undefined;
};

/**
 * The extras in a backup file (made here or on the web). Missing extras, or ones from a version
 * this build doesn't know, read as empty; a damaged entry is left out.
 */
export const readBackupExtras = (backupJson: unknown): BackupExtras => {
  const raw = recordOf(recordOf(backupJson)[BACKUP_EXTRAS_KEY]);
  const extras: BackupExtras = {
    collections: {},
    mealPlan: {},
    recipes: {},
    version: BACKUP_EXTRAS_VERSION
  };

  if (raw.version !== BACKUP_EXTRAS_VERSION) {
    return extras;
  }

  for (const [id, value] of Object.entries(recordOf(raw.recipes))) {
    const entry = recordOf(value);
    const extraction = readExtraction(entry.extraction);
    const servings = entry.preferredServings;
    extras.recipes[id] = {
      ...(extraction ? { extraction } : {}),
      ...(isDateTime(entry.lastCookedAt) ? { lastCookedAt: entry.lastCookedAt } : {}),
      ...(typeof servings === "number" && servings > 0 && servings <= MAX_MEAL_PLAN_SERVINGS
        ? { preferredServings: servings }
        : {})
    };
  }

  for (const [id, value] of Object.entries(recordOf(raw.collections))) {
    const entry = recordOf(value);
    extras.collections[id] = {
      ...(typeof entry.emoji === "string" && entry.emoji.trim()
        ? { emoji: entry.emoji.trim().slice(0, MAX_LIBRARY_COLLECTION_EMOJI_LENGTH) }
        : {}),
      ...(typeof entry.description === "string" && entry.description.trim()
        ? {
            description: entry.description
              .trim()
              .slice(0, MAX_LIBRARY_COLLECTION_DESCRIPTION_LENGTH)
          }
        : {}),
      ...(typeof entry.sortOrder === "number" && Number.isFinite(entry.sortOrder)
        ? { sortOrder: entry.sortOrder }
        : {})
    };
  }

  for (const [id, value] of Object.entries(recordOf(raw.mealPlan))) {
    const createdAt = recordOf(value).createdAt;
    extras.mealPlan[id] = isDateTime(createdAt) ? { createdAt } : {};
  }

  return extras;
};

/* ------------------------------------------------------------------------------------------------
 * Restore
 * ---------------------------------------------------------------------------------------------- */

export interface RestoreContext {
  collections: readonly MobileCollection[];
  createId: (kind: "collection" | "plan" | "recipe") => string;
  /** Personal recipes that still fit in the cookbook (Infinity when there is no limit). */
  freeSlots: number;
  mealPlan: readonly MealPlanEntry[];
  now: string;
  records: readonly SavedRecipeRecord[];
}

export interface RestoreCounts {
  collectionsCreated: number;
  /** Recipes already in the cookbook (kept as they are here). */
  duplicates: number;
  imported: number;
  mealPlanAdded: number;
  /** Recipes left out because the free cookbook is full. */
  overLimit: number;
  restoredStarters: number;
}

export interface RestorePlan {
  collections: MobileCollection[];
  counts: RestoreCounts;
  mealPlan: MealPlanEntry[];
  /** Collections a recipe already here belongs to in the backup but not yet here. */
  membershipAdditions: Array<{ collectionIds: string[]; recipeId: string }>;
  /** New recipes, and starters that replace the untouched copy here with the same id. */
  records: SavedRecipeRecord[];
}

const normalizeName = (name: string): string => name.trim().replace(/\s+/gu, " ").toLowerCase();

const cleanText = (value: string | null | undefined, maxLength: number): string | undefined =>
  value?.trim().replace(/\s+/gu, " ").slice(0, maxLength).trim() || undefined;

/** `preferred` when it is a usable id nobody has, otherwise a fresh one. */
const pickId = (
  preferred: string | undefined,
  taken: ReadonlySet<string>,
  create: () => string
): string => {
  let id = preferred && SAFE_ID_PATTERN.test(preferred) ? preferred : create();

  for (let attempt = 1; taken.has(id); attempt += 1) {
    id = attempt < 4 ? create() : `${create()}-${attempt}`;
  }

  return id;
};

const recipeKey = (sourceUrl: string, title: string): string =>
  `${canonicalizeRecipeUrl(sourceUrl) ?? sourceUrl}\n${normalizeName(title)}`;

/**
 * What restoring `backup` adds to this device, as the web app decides it. A recipe already here
 * (the same id, or the same link and title) is kept as it is here, but still joins the backup's
 * collections; only a starter nobody touched here is replaced by the backup's copy. New recipes
 * fit under the free limit in file order; starters come back outside it. Collections match by
 * id, then by name, and are otherwise created (an empty one only when it was empty in the backup
 * too). Planned meals already here (by id, or the same day, meal and recipe) are skipped. Nothing
 * the cook has here is overwritten or removed.
 */
export const planBackupRestore = (
  backup: LinkDishBackup,
  extras: BackupExtras,
  context: RestoreContext
): RestorePlan => {
  const counts: RestoreCounts = {
    collectionsCreated: 0,
    duplicates: 0,
    imported: 0,
    mealPlanAdded: 0,
    overLimit: 0,
    restoredStarters: 0
  };

  /* Collections ---------------------------------------------------------------------------- */
  const collectionIdMap = new Map<string, string>();
  const createdCollections: MobileCollection[] = [];
  const collectionsById = new Map(context.collections.map((entry) => [entry.id, entry]));
  const collectionsByName = new Map(
    context.collections.map((entry) => [normalizeName(entry.name), entry])
  );
  const takenCollectionIds = new Set(collectionsById.keys());
  let nextSortOrder =
    context.collections.reduce((max, entry) => Math.max(max, entry.sortOrder), -1) + 1;
  const backupCollections = backup.collections ?? [];
  const sortOrderOf = (id: string) => extras.collections[id]?.sortOrder ?? Number.MAX_SAFE_INTEGER;

  for (const collection of [...backupCollections].sort(
    (left, right) => sortOrderOf(left.id) - sortOrderOf(right.id)
  )) {
    const name = cleanText(collection.name, MAX_LIBRARY_COLLECTION_NAME_LENGTH);

    if (!name) {
      continue;
    }

    const match = collectionsById.get(collection.id) ?? collectionsByName.get(normalizeName(name));

    if (match) {
      collectionIdMap.set(collection.id, match.id);
      continue;
    }

    const id = pickId(collection.id, takenCollectionIds, () => context.createId("collection"));
    const collectionExtras = extras.collections[collection.id];
    const createdAt = collection.createdAt ?? context.now;
    const created: MobileCollection = {
      createdAt,
      id,
      name,
      sortOrder: nextSortOrder,
      updatedAt: collection.updatedAt ?? createdAt,
      ...(collectionExtras?.emoji ? { emoji: collectionExtras.emoji } : {}),
      ...(collectionExtras?.description ? { description: collectionExtras.description } : {})
    };

    takenCollectionIds.add(id);
    nextSortOrder += 1;
    collectionIdMap.set(collection.id, id);
    collectionsByName.set(normalizeName(name), created);
    createdCollections.push(created);
  }

  const collectionsForRecipe = new Map<string, string[]>();

  for (const collection of backupCollections) {
    const mapped = collectionIdMap.get(collection.id);

    for (const recipeId of mapped ? collection.recipeIds : []) {
      collectionsForRecipe.set(recipeId, [
        ...new Set([...(collectionsForRecipe.get(recipeId) ?? []), mapped!])
      ]);
    }
  }

  /* Recipes -------------------------------------------------------------------------------- */
  const existingById = new Map(context.records.map((record) => [record.id, record]));
  const existingByKey = new Map(
    context.records.map((record) => [
      recipeKey(record.recipe.sourceUrl, record.recipe.title),
      record
    ])
  );
  const takenRecipeIds = new Set(existingById.keys());
  const localIdByBackupId = new Map<string, string>();
  const records: SavedRecipeRecord[] = [];
  const membershipAdditions = new Map<string, Set<string>>();
  const restoredStarterIds = new Set<string>();
  let freeSlots = context.freeSlots;

  for (const entry of backup.recipes) {
    const backupId = entry.id;
    const collectionIds = backupId ? (collectionsForRecipe.get(backupId) ?? []) : [];
    const isStarter = backupId != null && STARTER_IDS.has(backupId);
    const localCopy = backupId ? existingById.get(backupId) : undefined;
    // A starter the cook made their own replaces the untouched copy seeded on this device.
    const replacesSeededStarter =
      isStarter &&
      !restoredStarterIds.has(backupId) &&
      localCopy?.isStarter === true &&
      !isPersonalized(localCopy);
    const duplicate = replacesSeededStarter
      ? undefined
      : (localCopy ?? existingByKey.get(recipeKey(entry.meta.sourceUrl, entry.recipe.title)));

    if (duplicate) {
      counts.duplicates += 1;

      if (backupId) {
        localIdByBackupId.set(backupId, duplicate.id);
      }

      const current = new Set(getRecipeCollectionIds(duplicate));
      const missing = collectionIds.filter((id) => !current.has(id));

      if (missing.length > 0 && existingById.has(duplicate.id)) {
        const set = membershipAdditions.get(duplicate.id) ?? new Set<string>();
        missing.forEach((id) => set.add(id));
        membershipAdditions.set(duplicate.id, set);
      }

      continue;
    }

    if (!isStarter && freeSlots <= 0) {
      counts.overLimit += 1;
      continue;
    }

    const id = isStarter
      ? backupId
      : pickId(backupId, takenRecipeIds, () => context.createId("recipe"));
    const record = toRestoredRecord(entry, id, collectionIds, extras.recipes[backupId ?? ""]);

    takenRecipeIds.add(id);
    existingByKey.set(recipeKey(record.recipe.sourceUrl, record.recipe.title), record);
    records.push(isStarter ? { ...record, isStarter: true } : record);

    if (backupId) {
      localIdByBackupId.set(backupId, id);
    }

    if (isStarter) {
      restoredStarterIds.add(id);
      counts.restoredStarters += 1;
    } else {
      freeSlots -= 1;
      counts.imported += 1;
    }
  }

  // A collection with no recipes on this device is only created if it was empty in the backup too.
  const usedCollectionIds = new Set([
    ...records.flatMap((record) => getRecipeCollectionIds(record)),
    ...[...membershipAdditions.values()].flatMap((set) => [...set])
  ]);
  const emptyInBackup = new Set(
    backupCollections
      .filter((collection) => collection.recipeIds.length === 0)
      .map((collection) => collectionIdMap.get(collection.id))
  );
  const collections = createdCollections.filter(
    (collection) => usedCollectionIds.has(collection.id) || emptyInBackup.has(collection.id)
  );
  counts.collectionsCreated = collections.length;

  /* Meal plan ------------------------------------------------------------------------------ */
  const takenMealIds = new Set(context.mealPlan.map((entry) => entry.id));
  const mealKey = (entry: Pick<MealPlanEntry, "date" | "recipeId" | "slot" | "title">) =>
    [entry.date, entry.slot, entry.recipeId ?? "", normalizeName(entry.title)].join("|");
  const takenMealKeys = new Set(context.mealPlan.map(mealKey));
  const titleByBackupId = new Map(
    backup.recipes.flatMap((entry) => (entry.id ? [[entry.id, entry.recipe.title] as const] : []))
  );
  const mealPlan: MealPlanEntry[] = [];

  for (const entry of backup.mealPlan ?? []) {
    if (takenMealIds.has(entry.id)) {
      continue;
    }

    const recipeId = entry.recipeId
      ? (localIdByBackupId.get(entry.recipeId) ??
        (existingById.has(entry.recipeId) ? entry.recipeId : undefined))
      : undefined;
    const title =
      cleanText(entry.title, MAX_MEAL_TITLE_LENGTH) ??
      cleanText(entry.recipeId ? titleByBackupId.get(entry.recipeId) : undefined, 200) ??
      "Planned meal";
    const servings =
      entry.servings != null && Number.isFinite(entry.servings) && entry.servings > 0
        ? Math.round(entry.servings * 100) / 100
        : undefined;
    const note = cleanText(entry.note, MAX_MEAL_NOTE_LENGTH);
    const updatedAt = entry.updatedAt ?? context.now;
    const restored: MealPlanEntry = {
      createdAt: extras.mealPlan[entry.id]?.createdAt ?? updatedAt,
      date: entry.date,
      id: pickId(entry.id, takenMealIds, () => context.createId("plan")),
      slot: entry.slot && isMealPlanSlot(entry.slot) ? entry.slot : "dinner",
      title,
      updatedAt,
      ...(recipeId ? { recipeId } : {}),
      ...(servings ? { servings } : {}),
      ...(note ? { note } : {})
    };
    const key = mealKey(restored);

    if (takenMealKeys.has(key)) {
      continue;
    }

    takenMealIds.add(restored.id);
    takenMealKeys.add(key);
    mealPlan.push(restored);
    counts.mealPlanAdded += 1;
  }

  return {
    collections,
    counts,
    mealPlan,
    membershipAdditions: [...membershipAdditions].map(([recipeId, set]) => ({
      collectionIds: [...set],
      recipeId
    })),
    records
  };
};

const toRestoredRecord = (
  entry: BackupRecipe,
  id: string,
  collectionIds: readonly string[],
  recipeExtras: BackupRecipeExtras | undefined
): SavedRecipeRecord => {
  const { meta } = entry;
  const cookLog = (meta.cookLog ?? []).slice(-MAX_LIBRARY_COOK_LOG_ENTRIES).map((log) => ({
    cookedAt: log.cookedAt,
    ...(log.note?.trim()
      ? { note: log.note.trim().slice(0, MAX_LIBRARY_COOK_LOG_NOTE_LENGTH) }
      : {})
  }));
  const tags = normalizeRecipeTags(meta.tags ?? []);
  const lastCookedAt = [recipeExtras?.lastCookedAt, ...cookLog.map((log) => log.cookedAt)]
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop();
  const libraryExtras: SavedRecipeLibraryExtras = {
    ...(tags.length ? { tags } : {}),
    ...(collectionIds.length ? { collectionIds: [...collectionIds] } : {}),
    ...(meta.rating ? { rating: meta.rating } : {}),
    ...(cookLog.length ? { cookLog } : {}),
    ...(lastCookedAt ? { lastCookedAt } : {}),
    ...(recipeExtras?.preferredServings
      ? { preferredServings: recipeExtras.preferredServings }
      : {})
  };
  const extraction = recipeExtras?.extraction ?? {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  };
  const notes = meta.notes?.trim();

  return {
    fetchMode: extraction.fetchMode,
    id,
    provenance: extraction.provenance,
    recipe: { ...entry.recipe, sourceUrl: entry.recipe.sourceUrl || meta.sourceUrl },
    savedAt: meta.createdAt > meta.updatedAt ? meta.updatedAt : meta.createdAt,
    strategy: extraction.strategy,
    timesCooked: Math.max(meta.timesCooked ?? 0, cookLog.length),
    updatedAt: meta.updatedAt,
    warnings: extraction.warnings,
    ...(meta.favorite ? { favorite: true } : {}),
    ...(notes ? { notes } : {}),
    ...(Object.keys(libraryExtras).length ? { libraryExtras } : {})
  };
};

/** "3 recipes", "1 collection" */
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const joinList = (items: readonly string[]): string =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;

/** What a restore did, for the screen ("Restored 3 recipes and 1 collection."). */
export const describeRestore = (counts: RestoreCounts): string => {
  const added = counts.imported + counts.restoredStarters;
  const restored = [
    added > 0 ? plural(added, "recipe", "recipes") : null,
    counts.collectionsCreated > 0
      ? plural(counts.collectionsCreated, "collection", "collections")
      : null,
    counts.mealPlanAdded > 0 ? plural(counts.mealPlanAdded, "planned meal", "planned meals") : null
  ].filter((part): part is string => part != null);
  const sentences = [
    restored.length ? `Restored ${joinList(restored)}.` : "Nothing new to restore."
  ];

  if (counts.duplicates > 0) {
    sentences.push(
      `${plural(counts.duplicates, "recipe was", "recipes were")} already in your cookbook.`
    );
  }

  if (counts.overLimit > 0) {
    sentences.push(
      `${plural(counts.overLimit, "recipe didn't", "recipes didn't")} fit in the free cookbook.`
    );
  }

  return sentences.join(" ");
};
