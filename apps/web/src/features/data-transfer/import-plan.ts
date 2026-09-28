/**
 * Deciding what an import will do, before anything is written: which recipes are already in the
 * cookbook, which ids they get, how many fit under the free limit, and how a LinkDish backup's
 * collections and meal plan map onto this device. {@link buildImportPlan} is synchronous and pure
 * so the writer can re-run it inside its IndexedDB transaction against fresh data (no awaits on
 * non-IndexedDB work may happen inside a transaction).
 */
import {
  canonicalizeRecipeUrl,
  isLikelySameRecipe,
  recipeUrlIdentity,
  SAMPLE_RECIPES
} from "@linkdish/recipe-domain";

import {
  generateDeterministicId,
  getSourceHost,
  LOCAL_LIMIT_FREE,
  normalizeRecipeTags
} from "../library/saved-recipe-store";

import { isPersonalizedRecipe } from "./export-selection";
import { isLinkDishInternalSourceUrl } from "./synthetic-url";

import type { ImportSource } from "./import-formats";
import type { ImportCandidate, ParsedImportFile } from "./import-sources";
import type { WebCollection } from "../../data/collections-store";
import type { MealPlanEntry, MealPlanSlot } from "../../data/meal-plan-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

export type DuplicateMode = "skip" | "keep";

const STARTER_ID_PREFIX = "starter-";
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/u;
const MAX_COOK_LOG_ENTRIES = 100;
const MAX_COLLECTION_NAME_LENGTH = 60;
const MAX_COLLECTION_DESCRIPTION_LENGTH = 280;
const MAX_MEAL_TITLE_LENGTH = 200;
const MAX_MEAL_NOTE_LENGTH = 500;
const DEFAULT_MEAL_SLOT: MealPlanSlot = "dinner";

/** Ids of the starter recipes LinkDish seeds on first run. */
export const KNOWN_STARTER_IDS: ReadonlySet<string> = new Set(
  SAMPLE_RECIPES.map((sample) => sample.id)
);

export interface AnalyzedCandidate {
  candidate: ImportCandidate;
  /** SHA-256(sourceUrl + title), the id a normal save would use. */
  deterministicId: string;
  /** The id this recipe gets when nothing is in the way. */
  preferredId: string;
  /** A known starter recipe from a LinkDish backup (restored as a starter, outside the quota). */
  starterId: string | null;
  /** The cookbook recipe this one duplicates, if any. */
  duplicateOfLocalId: string | null;
  /** The earlier recipe in the same file this one duplicates, if any. */
  duplicateOfIndex: number | null;
  /** The local copy is a starter nobody touched: restoring the backup's version replaces it. */
  replacesUntouchedStarter: boolean;
}

export interface ImportAnalysis {
  parsed: ParsedImportFile;
  items: AnalyzedCandidate[];
  /** Personal recipes on this device when the analysis ran (starters excluded). */
  quotaUsed: number;
}

interface ExistingIndexEntry {
  id: string;
  sourceUrl: string;
  title: string;
}

/** Fast duplicate lookups: exact URL identity, then same-site + same-title. */
class RecipeIndex {
  private readonly byIdentity = new Map<string, string>();
  private readonly byCanonical = new Map<string, string>();
  private readonly byHost = new Map<string, ExistingIndexEntry[]>();

  public add(entry: ExistingIndexEntry): void {
    if (isLinkDishInternalSourceUrl(entry.sourceUrl)) {
      // Made-up URLs are only equal when they are the same URL (every scan shares the host).
      const canonical = canonicalizeRecipeUrl(entry.sourceUrl);
      if (!this.byCanonical.has(canonical)) {
        this.byCanonical.set(canonical, entry.id);
      }
      return;
    }

    const identity = recipeUrlIdentity(entry.sourceUrl);
    if (!this.byIdentity.has(identity)) {
      this.byIdentity.set(identity, entry.id);
    }

    const host = getSourceHost(entry.sourceUrl);
    const list = this.byHost.get(host) ?? [];
    list.push(entry);
    this.byHost.set(host, list);
  }

  public find(sourceUrl: string, title: string): string | null {
    if (isLinkDishInternalSourceUrl(sourceUrl)) {
      return this.byCanonical.get(canonicalizeRecipeUrl(sourceUrl)) ?? null;
    }

    const exact = this.byIdentity.get(recipeUrlIdentity(sourceUrl));

    if (exact) {
      return exact;
    }

    const sameHost = this.byHost.get(getSourceHost(sourceUrl)) ?? [];
    return (
      sameHost.find((entry) =>
        isLikelySameRecipe({ sourceUrl, title }, { sourceUrl: entry.sourceUrl, title: entry.title })
      )?.id ?? null
    );
  }
}

const isStarterId = (id: string): boolean => id.startsWith(STARTER_ID_PREFIX);

/**
 * Compares each candidate with the cookbook (and earlier candidates in the same file): same id,
 * same deterministic id, or the same recipe per `isLikelySameRecipe`.
 */
export async function analyzeImport(
  parsed: ParsedImportFile,
  existing: readonly WebSavedRecipe[]
): Promise<ImportAnalysis> {
  const existingById = new Map(existing.map((recipe) => [recipe.id, recipe]));
  const localIndex = new RecipeIndex();
  const fileIndex = new RecipeIndex();

  for (const recipe of existing) {
    localIndex.add({ id: recipe.id, sourceUrl: recipe.sourceUrl, title: recipe.recipe.title });
  }

  const items: AnalyzedCandidate[] = [];

  for (const candidate of parsed.candidates) {
    const deterministicId = await generateDeterministicId(
      candidate.sourceUrl,
      candidate.recipe.title
    );
    const originalId =
      candidate.originalId && SAFE_ID_PATTERN.test(candidate.originalId)
        ? candidate.originalId
        : null;
    const starterId =
      parsed.source === "linkdish" && originalId && KNOWN_STARTER_IDS.has(originalId)
        ? originalId
        : null;
    // Unknown "starter-…" ids would dodge the free limit, so they get a regular id.
    const preferredId =
      starterId ?? (originalId && !isStarterId(originalId) ? originalId : deterministicId);

    const localById = existingById.get(preferredId) ?? existingById.get(deterministicId);
    const duplicateOfLocalId =
      localById?.id ?? localIndex.find(candidate.sourceUrl, candidate.recipe.title);
    const local = duplicateOfLocalId ? existingById.get(duplicateOfLocalId) : undefined;
    const replacesUntouchedStarter = Boolean(
      starterId &&
      local &&
      local.id === starterId &&
      local.isStarter &&
      !isPersonalizedRecipe(local)
    );
    const inFile = fileIndex.find(candidate.sourceUrl, candidate.recipe.title);

    items.push({
      candidate,
      deterministicId,
      preferredId,
      starterId,
      duplicateOfLocalId: replacesUntouchedStarter ? null : duplicateOfLocalId,
      duplicateOfIndex: inFile === null ? null : Number(inFile),
      replacesUntouchedStarter
    });

    fileIndex.add({
      id: String(candidate.index),
      sourceUrl: candidate.sourceUrl,
      title: candidate.recipe.title
    });
  }

  return {
    parsed,
    items,
    quotaUsed: existing.filter((recipe) => !isStarterId(recipe.id)).length
  };
}

/* ------------------------------------------------------------------------------------------------
 * Planning
 * ---------------------------------------------------------------------------------------------- */

export interface ImportPlanContext {
  duplicateMode: DuplicateMode;
  isPremium: boolean;
  /** Ids stored right now. */
  existingRecipeIds: ReadonlySet<string>;
  /** Personal recipes stored right now (starters excluded). */
  quotaUsed: number;
  existingCollections: readonly WebCollection[];
  existingMealPlan: readonly MealPlanEntry[];
  now: string;
  createId: () => string;
}

export interface ImportPlanCounts {
  /** Recipes found in the file (readable ones). */
  found: number;
  /** New recipe records that will be written. */
  imported: number;
  /** Recipes already in the cookbook (or repeated in the file). */
  duplicates: number;
  /** Duplicates left out ("Skip duplicates"). */
  skippedDuplicates: number;
  /** Duplicates imported as a second copy ("Keep both"). */
  keptDuplicates: number;
  /** Recipes left out because the free cookbook is full. */
  overLimit: number;
  /** Starter recipes restored with their personal touches. */
  restoredStarters: number;
  collectionsCreated: number;
  collectionsMatched: number;
  mealPlanAdded: number;
  mealPlanSkipped: number;
}

export interface ImportPlan {
  /** New records, with `sourceImages` when the backup carried scans. */
  recipes: WebSavedRecipe[];
  /** Collections to add to recipes already in the cookbook. */
  membershipAdditions: Array<{ recipeId: string; collectionIds: string[] }>;
  collections: WebCollection[];
  mealPlan: MealPlanEntry[];
  counts: ImportPlanCounts;
  /** Free space left before the import (Infinity for Plus and Family). */
  remainingFreeSlots: number;
  limitReached: boolean;
}

const EXTRACTION_BY_SOURCE: Record<ImportSource, WebSavedRecipe["extraction"]> = {
  linkdish: { fetchMode: "http", provenance: ["jsonld"], strategy: "recipe-schema", warnings: [] },
  mela: {
    fetchMode: "http",
    provenance: ["visible-text"],
    strategy: "recipe-schema",
    warnings: []
  },
  paprika: {
    fetchMode: "http",
    provenance: ["visible-text"],
    strategy: "recipe-schema",
    warnings: []
  },
  schema_org: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  }
};

const latest = (values: ReadonlyArray<string | undefined>): string | undefined =>
  values.reduce<string | undefined>(
    (max, value) => (value && (!max || value > max) ? value : max),
    undefined
  );

/** A third-party import keeps the file's order in "recently updated" sorting. */
const orderedTimestamp = (now: string, index: number): string => {
  const time = Date.parse(now);
  return Number.isFinite(time) ? new Date(time - index).toISOString() : now;
};

const toSavedRecord = (
  item: AnalyzedCandidate,
  id: string,
  source: ImportSource,
  now: string,
  options: { isStarter: boolean; collectionIds: readonly string[] }
): WebSavedRecipe => {
  const { candidate } = item;
  const cookLog = candidate.cookLog?.slice(-MAX_COOK_LOG_ENTRIES);
  const tags = candidate.tags ? normalizeRecipeTags(candidate.tags) : [];
  const updatedAt =
    source === "linkdish"
      ? (candidate.updatedAt ?? candidate.createdAt ?? now)
      : orderedTimestamp(now, candidate.index);
  const createdAt = candidate.createdAt ?? updatedAt;
  const lastCookedAt = latest([candidate.lastCookedAt, ...(cookLog ?? []).map((e) => e.cookedAt)]);
  const collectionIds = Array.from(new Set(options.collectionIds));

  return {
    id,
    recipe: candidate.recipe,
    sourceUrl: candidate.sourceUrl,
    sourceHost: getSourceHost(candidate.sourceUrl),
    createdAt: createdAt > updatedAt ? updatedAt : createdAt,
    updatedAt,
    extraction: candidate.extraction ?? EXTRACTION_BY_SOURCE[source],
    timesCooked: Math.max(candidate.timesCooked ?? 0, cookLog?.length ?? 0),
    sync: { status: "local_only" },
    ...(options.isStarter ? { isStarter: true } : {}),
    ...(candidate.notes ? { notes: candidate.notes } : {}),
    ...(candidate.favorite ? { favorite: true } : {}),
    ...(tags.length ? { tags } : {}),
    ...(collectionIds.length ? { collectionIds } : {}),
    ...(candidate.rating ? { rating: candidate.rating } : {}),
    ...(cookLog?.length ? { cookLog } : {}),
    ...(lastCookedAt ? { lastCookedAt } : {}),
    ...(candidate.lastOpenedAt ? { lastOpenedAt: candidate.lastOpenedAt } : {}),
    ...(candidate.preferredServings ? { preferredServings: candidate.preferredServings } : {}),
    ...(candidate.sourceImages?.length ? { sourceImages: candidate.sourceImages } : {})
  };
};

/** `preferred`, or a fresh id when it is taken (retrying guards against a repeating id source). */
const uniqueId = (
  preferred: string,
  taken: ReadonlySet<string>,
  createId: () => string
): string => {
  let id = preferred;

  for (let attempt = 1; taken.has(id); attempt += 1) {
    id = attempt < 4 ? createId() : `${createId()}-${attempt}`;
  }

  return id;
};

const normalizeName = (name: string): string => name.trim().replace(/\s+/gu, " ").toLowerCase();

const cleanText = (value: string | null | undefined, maxLength: number): string | undefined => {
  const cleaned = value?.trim().replace(/\s+/gu, " ").slice(0, maxLength).trim();
  return cleaned || undefined;
};

/**
 * What an import will write, given the analysis and the current state of this device. Pure and
 * synchronous: the writer calls it again inside its transaction with freshly read state.
 */
export function buildImportPlan(analysis: ImportAnalysis, context: ImportPlanContext): ImportPlan {
  const { parsed, items } = analysis;
  const taken = new Set(context.existingRecipeIds);
  const remainingFreeSlots = context.isPremium
    ? Number.POSITIVE_INFINITY
    : Math.max(0, LOCAL_LIMIT_FREE - context.quotaUsed);
  let usedSlots = 0;

  const counts: ImportPlanCounts = {
    found: items.length,
    imported: 0,
    duplicates: 0,
    skippedDuplicates: 0,
    keptDuplicates: 0,
    overLimit: 0,
    restoredStarters: 0,
    collectionsCreated: 0,
    collectionsMatched: 0,
    mealPlanAdded: 0,
    mealPlanSkipped: 0
  };

  /* Collections (LinkDish backups): match by id, then by name; otherwise create. ------------ */
  const collectionIdMap = new Map<string, string>();
  const newCollections: WebCollection[] = [];
  const collectionsById = new Map(context.existingCollections.map((c) => [c.id, c]));
  const collectionsByName = new Map(
    context.existingCollections.map((c) => [normalizeName(c.name), c])
  );
  const takenCollectionIds = new Set(collectionsById.keys());
  let nextSortOrder =
    context.existingCollections.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;

  const orderedCollections = [...parsed.collections].sort(
    (left, right) =>
      (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER)
  );

  for (const collection of orderedCollections) {
    const name = cleanText(collection.name, MAX_COLLECTION_NAME_LENGTH);

    if (!name) {
      continue;
    }

    const match = collectionsById.get(collection.id) ?? collectionsByName.get(normalizeName(name));

    if (match) {
      collectionIdMap.set(collection.id, match.id);
      counts.collectionsMatched += 1;
      continue;
    }

    const id = uniqueId(
      SAFE_ID_PATTERN.test(collection.id) ? collection.id : context.createId(),
      takenCollectionIds,
      context.createId
    );
    takenCollectionIds.add(id);

    const description = cleanText(collection.description, MAX_COLLECTION_DESCRIPTION_LENGTH);
    const created: WebCollection = {
      id,
      name,
      sortOrder: nextSortOrder,
      createdAt: collection.createdAt ?? context.now,
      updatedAt: collection.updatedAt ?? collection.createdAt ?? context.now,
      ...(collection.emoji ? { emoji: collection.emoji } : {}),
      ...(description ? { description } : {})
    };
    nextSortOrder += 1;
    collectionIdMap.set(collection.id, id);
    collectionsByName.set(normalizeName(name), created);
    newCollections.push(created);
  }

  const collectionsForOriginal = new Map<string, string[]>();
  for (const collection of parsed.collections) {
    const mapped = collectionIdMap.get(collection.id);

    if (!mapped) {
      continue;
    }

    for (const recipeId of collection.recipeIds) {
      const list = collectionsForOriginal.get(recipeId) ?? [];
      list.push(mapped);
      collectionsForOriginal.set(recipeId, list);
    }
  }

  /* Recipes -------------------------------------------------------------------------------- */
  const recipes: WebSavedRecipe[] = [];
  /** Original (backup) id or file position → the local id the recipe ends up with. */
  const localIdByOriginal = new Map<string, string>();
  const localIdByIndex = new Map<number, string>();
  const membershipAdditions = new Map<string, Set<string>>();
  const restoredStarterIds = new Set<string>();

  for (const item of items) {
    const { candidate } = item;
    const collectionIds = candidate.originalId
      ? (collectionsForOriginal.get(candidate.originalId) ?? [])
      : [];
    const remember = (localId: string) => {
      localIdByIndex.set(candidate.index, localId);
      if (candidate.originalId) {
        localIdByOriginal.set(candidate.originalId, localId);
      }
    };

    // A starter from the backup: replace an untouched local copy, or restore a missing one.
    if (
      item.starterId &&
      !restoredStarterIds.has(item.starterId) &&
      (item.replacesUntouchedStarter
        ? context.existingRecipeIds.has(item.starterId)
        : !taken.has(item.starterId))
    ) {
      taken.add(item.starterId);
      restoredStarterIds.add(item.starterId);
      recipes.push(
        toSavedRecord(item, item.starterId, parsed.source, context.now, {
          isStarter: true,
          collectionIds
        })
      );
      remember(item.starterId);
      counts.restoredStarters += 1;
      continue;
    }

    const duplicateLocalId =
      item.duplicateOfLocalId && context.existingRecipeIds.has(item.duplicateOfLocalId)
        ? item.duplicateOfLocalId
        : null;
    const duplicateInFileId =
      item.duplicateOfIndex === null ? null : (localIdByIndex.get(item.duplicateOfIndex) ?? null);
    const isDuplicate =
      duplicateLocalId !== null ||
      item.duplicateOfIndex !== null ||
      // Written by someone else since the analysis ran.
      (!item.duplicateOfLocalId && context.existingRecipeIds.has(item.preferredId));

    if (isDuplicate) {
      counts.duplicates += 1;

      if (context.duplicateMode === "skip") {
        counts.skippedDuplicates += 1;
        const localId =
          duplicateLocalId ??
          duplicateInFileId ??
          (context.existingRecipeIds.has(item.preferredId) ? item.preferredId : null);

        if (localId) {
          remember(localId);

          // Restoring a backup onto a cookbook that already has the recipe still restores
          // which collections it belongs to.
          if (collectionIds.length && context.existingRecipeIds.has(localId)) {
            const set = membershipAdditions.get(localId) ?? new Set<string>();
            collectionIds.forEach((collectionId) => set.add(collectionId));
            membershipAdditions.set(localId, set);
          }
        }

        continue;
      }
    }

    if (usedSlots >= remainingFreeSlots) {
      counts.overLimit += 1;
      continue;
    }

    const id = uniqueId(
      isDuplicate ? context.createId() : item.preferredId,
      taken,
      context.createId
    );
    taken.add(id);
    usedSlots += 1;
    recipes.push(
      toSavedRecord(item, id, parsed.source, context.now, { isStarter: false, collectionIds })
    );
    remember(id);
    counts.imported += 1;

    if (isDuplicate) {
      counts.keptDuplicates += 1;
    }
  }

  // Collections that ended up with no recipes on this device are only created when they were
  // empty in the backup too.
  const usedCollectionIds = new Set<string>([
    ...recipes.flatMap((recipe) => recipe.collectionIds ?? []),
    ...Array.from(membershipAdditions.values()).flatMap((set) => Array.from(set))
  ]);
  const emptyInBackup = new Set(
    parsed.collections
      .filter((collection) => collection.recipeIds.length === 0)
      .map((collection) => collectionIdMap.get(collection.id))
  );
  const collections = newCollections.filter(
    (collection) => usedCollectionIds.has(collection.id) || emptyInBackup.has(collection.id)
  );
  counts.collectionsCreated = collections.length;

  /* Meal plan (LinkDish backups) ---------------------------------------------------------- */
  const existingMealIds = new Set(context.existingMealPlan.map((entry) => entry.id));
  const mealKey = (entry: Pick<MealPlanEntry, "date" | "slot" | "recipeId" | "title">) =>
    [entry.date, entry.slot, entry.recipeId ?? "", normalizeName(entry.title)].join("|");
  const existingMealKeys = new Set(context.existingMealPlan.map(mealKey));
  const titleByOriginal = new Map(
    items
      .filter((item) => item.candidate.originalId)
      .map((item) => [item.candidate.originalId as string, item.candidate.recipe.title])
  );
  const mealPlan: MealPlanEntry[] = [];

  for (const entry of parsed.mealPlan) {
    if (existingMealIds.has(entry.id)) {
      counts.mealPlanSkipped += 1;
      continue;
    }

    const recipeId = entry.recipeId
      ? (localIdByOriginal.get(entry.recipeId) ??
        (context.existingRecipeIds.has(entry.recipeId) ? entry.recipeId : undefined))
      : undefined;
    const title =
      cleanText(entry.title, MAX_MEAL_TITLE_LENGTH) ??
      cleanText(entry.recipeId ? titleByOriginal.get(entry.recipeId) : undefined, 200) ??
      "Planned meal";
    const servings =
      entry.servings != null && Number.isFinite(entry.servings) && entry.servings > 0
        ? Math.round(entry.servings * 100) / 100
        : undefined;
    const note = cleanText(entry.note, MAX_MEAL_NOTE_LENGTH);
    const id = uniqueId(
      SAFE_ID_PATTERN.test(entry.id) ? entry.id : context.createId(),
      existingMealIds,
      context.createId
    );

    const restored: MealPlanEntry = {
      id,
      date: entry.date,
      slot: entry.slot ?? DEFAULT_MEAL_SLOT,
      title,
      createdAt: entry.createdAt ?? entry.updatedAt ?? context.now,
      updatedAt: entry.updatedAt ?? context.now,
      ...(recipeId ? { recipeId } : {}),
      ...(servings ? { servings } : {}),
      ...(note ? { note } : {})
    };
    const key = mealKey(restored);

    if (existingMealKeys.has(key)) {
      counts.mealPlanSkipped += 1;
      continue;
    }

    existingMealIds.add(id);
    existingMealKeys.add(key);
    mealPlan.push(restored);
    counts.mealPlanAdded += 1;
  }

  return {
    recipes,
    membershipAdditions: Array.from(membershipAdditions.entries(), ([recipeId, set]) => ({
      recipeId,
      collectionIds: Array.from(set)
    })),
    collections,
    mealPlan,
    counts,
    remainingFreeSlots,
    limitReached: counts.overLimit > 0
  };
}
