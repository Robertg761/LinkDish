import {
  formatServings,
  getRecipeTimes,
  parseServings,
  recipeSourceLabel
} from "@linkdish/recipe-domain";

import { safeGetItem, safeSetItem } from "../../../platform/safe-storage";

import type { WebCollection } from "../../../data/collections-store";
import type { WebSavedRecipe } from "../saved-recipe-types";
import type { SharedRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

/* ------------------------------------------------------------------------------------------------
 * Sort, view and direction preferences
 * ---------------------------------------------------------------------------------------------- */

/** `recent`, `az` and `mostCooked` are the keys people already have stored. */
export type LibrarySort =
  | "recent"
  | "recentlyCooked"
  | "az"
  | "mostCooked"
  | "quickest"
  | "topRated";
export type LibrarySortDirection = "forward" | "reverse";
export type LibraryView = "grid" | "list";
export type LibraryTab = "personal" | "family";

export const LIBRARY_SORT_STORAGE_KEY = "linkdish:web:cookbook-sort:v1";
export const LIBRARY_SORT_DIRECTION_STORAGE_KEY = "linkdish:web:cookbook-sort-direction:v1";
export const LIBRARY_VIEW_STORAGE_KEY = "linkdish:web:cookbook-view:v1";

export const LIBRARY_SORT_OPTIONS: ReadonlyArray<{
  value: LibrarySort;
  label: string;
  /** For the phone toolbar, where the full label doesn't fit beside the view toggle. */
  shortLabel: string;
}> = [
  { value: "recent", label: "Recently added", shortLabel: "Newest" },
  { value: "recentlyCooked", label: "Recently cooked", shortLabel: "Last cooked" },
  { value: "az", label: "A–Z", shortLabel: "A–Z" },
  { value: "mostCooked", label: "Most cooked", shortLabel: "Most cooked" },
  { value: "quickest", label: "Quickest", shortLabel: "Quickest" },
  { value: "topRated", label: "Top rated", shortLabel: "Top rated" }
];

/** Family recipes carry no personal cooking history or ratings. */
export const FAMILY_SORTS: ReadonlySet<LibrarySort> = new Set(["recent", "az", "quickest"]);

const SORT_VALUES = new Set<string>(LIBRARY_SORT_OPTIONS.map((option) => option.value));

export const isLibrarySort = (value: unknown): value is LibrarySort =>
  typeof value === "string" && SORT_VALUES.has(value);

export const readStoredSort = (): LibrarySort => {
  const stored = safeGetItem(LIBRARY_SORT_STORAGE_KEY);
  return isLibrarySort(stored) ? stored : "recent";
};

export const readStoredSortDirection = (): LibrarySortDirection =>
  safeGetItem(LIBRARY_SORT_DIRECTION_STORAGE_KEY) === "reverse" ? "reverse" : "forward";

export const readStoredView = (): LibraryView =>
  safeGetItem(LIBRARY_VIEW_STORAGE_KEY) === "list" ? "list" : "grid";

export const storeSort = (sort: LibrarySort): void => {
  safeSetItem(LIBRARY_SORT_STORAGE_KEY, sort);
};

export const storeSortDirection = (direction: LibrarySortDirection): void => {
  safeSetItem(LIBRARY_SORT_DIRECTION_STORAGE_KEY, direction);
};

export const storeView = (view: LibraryView): void => {
  safeSetItem(LIBRARY_VIEW_STORAGE_KEY, view);
};

export const getSortLabel = (sort: LibrarySort): string =>
  LIBRARY_SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "Recently added";

export const getShortSortLabel = (sort: LibrarySort): string =>
  LIBRARY_SORT_OPTIONS.find((option) => option.value === sort)?.shortLabel ?? "Newest";

/* ------------------------------------------------------------------------------------------------
 * Derived, render-ready data per recipe
 * ---------------------------------------------------------------------------------------------- */

export const QUICK_MAX_MINUTES = 30;
const STARTER_ID_PREFIX = "starter-";

export interface RecipeFacts {
  /** Total minutes (the recipe's own total, else prep + cook), or null when unknown. */
  totalMinutes: number | null;
  /** "35 min", or null. */
  totalLabel: string | null;
  /** Card-sized total: "35 min", "1h 20m", "3h" (fits a narrow grid card), or null. */
  totalShort: string | null;
  /** "Serves 4", "12 cookies" (side yields dropped so it fits a card), or null. */
  servingsLabel: string | null;
  /** The count alone for people served ("4–6"), or the item label ("12 cookies"), or null. */
  servingsShort: string | null;
  /** Whether `servingsShort` counts people (shown with a people icon). */
  servingsArePeople: boolean;
  /** "seriouseats.com", "Scanned image". */
  sourceLabel: string;
}

const factsCache = new WeakMap<Recipe, RecipeFacts>();
const SERVES_PREFIX = "Serves ";

/** Card-sized servings: the domain label without the side yield ("Serves 16", not "… · 1 loaf"). */
export const formatCompactServings = (servings: string | null | undefined): string | null => {
  const parsed = parseServings(servings);

  if (!parsed) {
    const raw = servings?.trim() ?? "";
    // Unparseable text ("Varies") is only worth showing when it is short.
    return raw && raw.length <= 18 && !/^\d/u.test(raw) ? raw : null;
  }

  const label = formatServings(parsed);
  return parsed.yield ? label.replace(` · ${parsed.yield}`, "") : label;
};

/** Card-sized minutes: "45 min" under an hour, then "1h 20m", "3h", "1d 2h". */
export const formatCompactDuration = (minutes: number | null | undefined): string | null => {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  const rounded = Math.round(minutes);

  if (rounded < 60) {
    return `${rounded} min`;
  }

  const days = Math.floor(rounded / (24 * 60));
  const hours = Math.floor((rounded % (24 * 60)) / 60);
  const mins = rounded % 60;

  return days > 0
    ? `${days}d${hours > 0 ? ` ${hours}h` : ""}`
    : `${hours}h${mins > 0 ? ` ${mins}m` : ""}`;
};

/**
 * The count a card can show beside its icon: "4–6" for people, "36 cookies", "9 pancakes"
 * (a multi-word yield keeps its last word, so "9 small pancakes" fits a narrow card).
 */
const formatShortServings = (servings: string | null | undefined): string | null => {
  const parsed = parseServings(servings);

  if (!parsed) {
    return formatCompactServings(servings);
  }

  const label = formatCompactServings(servings);

  if (parsed.kind === "servings" || !parsed.noun || !label) {
    return label?.startsWith(SERVES_PREFIX) ? label.slice(SERVES_PREFIX.length) : label;
  }

  const words = parsed.noun.split(/\s+/u);
  return words.length > 1
    ? label.replace(parsed.noun, words[words.length - 1] ?? parsed.noun)
    : label;
};

/** Times, servings and source for a recipe, cached per recipe object (metadata edits reuse it). */
export const getRecipeFacts = (recipe: Recipe): RecipeFacts => {
  const cached = factsCache.get(recipe);

  if (cached) {
    return cached;
  }

  const times = getRecipeTimes(recipe);
  const servingsLabel = formatCompactServings(recipe.servings);
  const servingsArePeople = Boolean(servingsLabel?.startsWith(SERVES_PREFIX));
  const facts: RecipeFacts = {
    servingsArePeople,
    servingsLabel,
    servingsShort: formatShortServings(recipe.servings),
    sourceLabel: recipeSourceLabel(recipe.sourceUrl),
    totalLabel: times.labels.total,
    totalMinutes: times.total && times.total > 0 ? times.total : null,
    totalShort: formatCompactDuration(times.total)
  };

  factsCache.set(recipe, facts);
  return facts;
};

/** One quiet meta line: "35 min · Serves 4" (plus the source on roomy list rows). */
export const formatRecipeMeta = (
  recipe: Recipe,
  options: { includeSource?: boolean | undefined } = {}
): string => {
  const facts = getRecipeFacts(recipe);

  return [facts.totalLabel, facts.servingsLabel, options.includeSource ? facts.sourceLabel : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
};

export const isStarterRecipe = (recipe: Pick<WebSavedRecipe, "id" | "isStarter">): boolean =>
  Boolean(recipe.isStarter) || recipe.id.startsWith(STARTER_ID_PREFIX);

/** Personal recipes that count toward the free limit (same rule as `countQuotaSavedRecipes`). */
export const countQuotaRecipes = (recipes: readonly WebSavedRecipe[]): number =>
  recipes.filter((recipe) => !recipe.id.startsWith(STARTER_ID_PREFIX)).length;

/** The cook's own recipes and LinkDish's starters, counted the way the free limit counts them. */
export const countCookbook = (
  recipes: readonly WebSavedRecipe[]
): { saved: number; starters: number } => {
  const saved = countQuotaRecipes(recipes);
  return { saved, starters: recipes.length - saved };
};

export const isQuickRecipe = (recipe: Recipe): boolean => {
  const total = getRecipeFacts(recipe).totalMinutes;
  return total != null && total <= QUICK_MAX_MINUTES;
};

export const normalizeText = (value: string): string => value.replace(/\u00a0/gu, " ");

/** The importer, pre-filled with a link (the same shape the share target uses). */
export const buildImportPath = (url: string): string => `/import?url=${encodeURIComponent(url)}`;

/* ------------------------------------------------------------------------------------------------
 * Sorting
 * ---------------------------------------------------------------------------------------------- */

const timeOf = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

/*
 * One collator for every A–Z comparison: `localeCompare` with an options object resolves a new
 * collator on each call (about 20x slower over a 2,000-recipe sort). Same order.
 */
const TITLE_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

const compareTitles = (left: string, right: string): number =>
  TITLE_COLLATOR.compare(normalizeText(left), normalizeText(right));

/** Sorts by a precomputed title key (decorate, sort, undecorate), so each title is read once. */
const sortByTitle = <T>(records: readonly T[], titleOf: (record: T) => string): T[] =>
  records
    .map((record) => ({ key: normalizeText(titleOf(record)), record }))
    .sort((left, right) => TITLE_COLLATOR.compare(left.key, right.key))
    .map((entry) => entry.record);

const byRecentlyAdded = (left: WebSavedRecipe, right: WebSavedRecipe): number =>
  timeOf(right.createdAt) - timeOf(left.createdAt) ||
  timeOf(right.updatedAt) - timeOf(left.updatedAt);

const unknownLast = (value: number | null): number => value ?? Number.POSITIVE_INFINITY;

const PERSONAL_COMPARATORS: Record<
  LibrarySort,
  (left: WebSavedRecipe, right: WebSavedRecipe) => number
> = {
  recent: byRecentlyAdded,
  recentlyCooked: (left, right) =>
    timeOf(right.lastCookedAt) - timeOf(left.lastCookedAt) || byRecentlyAdded(left, right),
  az: (left, right) => compareTitles(left.recipe.title, right.recipe.title),
  mostCooked: (left, right) =>
    (right.timesCooked ?? 0) - (left.timesCooked ?? 0) || byRecentlyAdded(left, right),
  quickest: (left, right) =>
    unknownLast(getRecipeFacts(left.recipe).totalMinutes) -
      unknownLast(getRecipeFacts(right.recipe).totalMinutes) || byRecentlyAdded(left, right),
  topRated: (left, right) =>
    (right.rating ?? 0) - (left.rating ?? 0) ||
    (right.timesCooked ?? 0) - (left.timesCooked ?? 0) ||
    byRecentlyAdded(left, right)
};

export const sortPersonalRecipes = (
  recipes: readonly WebSavedRecipe[],
  sort: LibrarySort,
  direction: LibrarySortDirection = "forward"
): WebSavedRecipe[] => {
  const sorted =
    sort === "az"
      ? sortByTitle(recipes, (recipe) => recipe.recipe.title)
      : [...recipes].sort(PERSONAL_COMPARATORS[sort]);
  return direction === "reverse" ? sorted.reverse() : sorted;
};

export const sortSharedRecipes = (
  recipes: readonly SharedRecipe[],
  sort: LibrarySort,
  direction: LibrarySortDirection = "forward"
): SharedRecipe[] => {
  if (sort === "az") {
    const sorted = sortByTitle(recipes, (recipe) => recipe.recipe.title);
    return direction === "reverse" ? sorted.reverse() : sorted;
  }

  const sorted = [...recipes].sort((left, right) => {
    if (sort === "quickest") {
      return (
        unknownLast(getRecipeFacts(left.recipe).totalMinutes) -
          unknownLast(getRecipeFacts(right.recipe).totalMinutes) ||
        timeOf(right.updatedAt) - timeOf(left.updatedAt)
      );
    }

    return timeOf(right.updatedAt) - timeOf(left.updatedAt);
  });

  return direction === "reverse" ? sorted.reverse() : sorted;
};

/* ------------------------------------------------------------------------------------------------
 * Filters (multi-select, AND)
 * ---------------------------------------------------------------------------------------------- */

export type LibraryFilterKey = string;

export const FAVORITES_FILTER = "favorites";
export const QUICK_FILTER = "quick";
export const NOT_COOKED_FILTER = "not-cooked";
const COLLECTION_FILTER_PREFIX = "collection:";
const TAG_FILTER_PREFIX = "tag:";

export const collectionFilterKey = (collectionId: string): LibraryFilterKey =>
  `${COLLECTION_FILTER_PREFIX}${collectionId}`;

export const tagFilterKey = (tag: string): LibraryFilterKey =>
  `${TAG_FILTER_PREFIX}${tag.trim().toLowerCase()}`;

const hasTag = (recipe: WebSavedRecipe, lowerTag: string): boolean =>
  recipe.tags?.some((tag) => tag.toLowerCase() === lowerTag) ?? false;

export const matchesFilter = (recipe: WebSavedRecipe, key: LibraryFilterKey): boolean => {
  if (key === FAVORITES_FILTER) {
    return Boolean(recipe.favorite);
  }

  if (key === QUICK_FILTER) {
    return isQuickRecipe(recipe.recipe);
  }

  if (key === NOT_COOKED_FILTER) {
    return !(recipe.timesCooked ?? 0) && !recipe.lastCookedAt;
  }

  if (key.startsWith(COLLECTION_FILTER_PREFIX)) {
    return recipe.collectionIds?.includes(key.slice(COLLECTION_FILTER_PREFIX.length)) ?? false;
  }

  if (key.startsWith(TAG_FILTER_PREFIX)) {
    return hasTag(recipe, key.slice(TAG_FILTER_PREFIX.length));
  }

  return true;
};

/** A predicate for all active filters (AND); `null` when nothing is filtered. */
export const buildFilterPredicate = (
  keys: readonly LibraryFilterKey[]
): ((recipe: WebSavedRecipe) => boolean) | null =>
  keys.length === 0 ? null : (recipe) => keys.every((key) => matchesFilter(recipe, key));

export interface TagSummary {
  key: LibraryFilterKey;
  label: string;
  count: number;
}

/** The most used personal tags, most used first (case-insensitive; first spelling wins). */
export const getTopTags = (recipes: readonly WebSavedRecipe[], limit = 8): TagSummary[] => {
  const tags = new Map<string, TagSummary>();

  for (const recipe of recipes) {
    for (const tag of recipe.tags ?? []) {
      const lower = tag.toLowerCase();
      const existing = tags.get(lower);

      if (existing) {
        existing.count += 1;
      } else {
        tags.set(lower, { count: 1, key: tagFilterKey(tag), label: tag });
      }
    }
  }

  return [...tags.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit);
};

/** Every tag used in the cookbook, most used first (for tag suggestions). */
export const getAllTags = (recipes: readonly WebSavedRecipe[]): string[] =>
  getTopTags(recipes, Number.POSITIVE_INFINITY).map((tag) => tag.label);

export interface FilterChipModel {
  key: LibraryFilterKey;
  label: string;
  count: number;
  icon?: "heart" | "zap" | "sparkles" | "tag" | undefined;
  emoji?: string | undefined;
}

const FILTER_TAG_LIMIT = 6;
/** A tag on a single recipe filters to one card, which search already does better. */
const FILTER_TAG_MIN_USES = 2;

/** The chip row: built-in smart filters, then collections, then the most used tags. */
export const buildFilterChips = (
  recipes: readonly WebSavedRecipe[],
  collections: readonly WebCollection[]
): FilterChipModel[] => {
  let favorites = 0;
  let quick = 0;
  let notCooked = 0;
  const collectionCounts = new Map<string, number>();

  for (const recipe of recipes) {
    if (recipe.favorite) {
      favorites += 1;
    }

    if (isQuickRecipe(recipe.recipe)) {
      quick += 1;
    }

    if (matchesFilter(recipe, NOT_COOKED_FILTER)) {
      notCooked += 1;
    }

    for (const id of recipe.collectionIds ?? []) {
      collectionCounts.set(id, (collectionCounts.get(id) ?? 0) + 1);
    }
  }

  return [
    { count: favorites, icon: "heart", key: FAVORITES_FILTER, label: "Favorites" },
    { count: quick, icon: "zap", key: QUICK_FILTER, label: "Quick" },
    { count: notCooked, icon: "sparkles", key: NOT_COOKED_FILTER, label: "Not cooked yet" },
    ...collections.map((collection) => ({
      count: collectionCounts.get(collection.id) ?? 0,
      emoji: collection.emoji,
      key: collectionFilterKey(collection.id),
      label: collection.name
    })),
    ...getTopTags(recipes, FILTER_TAG_LIMIT)
      .filter((tag) => tag.count >= FILTER_TAG_MIN_USES)
      .map((tag) => ({ ...tag, icon: "tag" as const }))
  ];
};

/* ------------------------------------------------------------------------------------------------
 * Shelves
 * ---------------------------------------------------------------------------------------------- */

export const SHELF_MIN_LIBRARY_SIZE = 6;
const SHELF_SIZE = 10;
const SHELF_MIN_ITEMS = 2;

export interface LibraryShelfModel {
  id: "cook-again" | "quick" | "recent";
  title: string;
  recipes: WebSavedRecipe[];
}

/**
 * "Cook again", "Quick weeknights" and "Recently added" rows for a big enough cookbook.
 * "Recently added" is skipped while the grid below is already sorted that way.
 */
export const buildShelves = (
  recipes: readonly WebSavedRecipe[],
  sort: LibrarySort = "az"
): LibraryShelfModel[] => {
  if (recipes.length < SHELF_MIN_LIBRARY_SIZE) {
    return [];
  }

  const cooked = recipes
    .filter((recipe) => (recipe.timesCooked ?? 0) > 0 || recipe.lastCookedAt)
    .sort(
      (left, right) =>
        timeOf(right.lastCookedAt) - timeOf(left.lastCookedAt) ||
        (right.timesCooked ?? 0) - (left.timesCooked ?? 0)
    )
    .slice(0, SHELF_SIZE);
  const quick = sortPersonalRecipes(
    recipes.filter((recipe) => isQuickRecipe(recipe.recipe)),
    "recent"
  ).slice(0, SHELF_SIZE);
  const recent =
    sort === "recent" ? [] : sortPersonalRecipes(recipes, "recent").slice(0, SHELF_SIZE);

  return [
    { id: "cook-again" as const, recipes: cooked, title: "Cook again" },
    { id: "quick" as const, recipes: quick, title: "Quick weeknights" },
    { id: "recent" as const, recipes: recent, title: "Recently added" }
  ].filter((shelf) => shelf.recipes.length >= SHELF_MIN_ITEMS);
};

/* ------------------------------------------------------------------------------------------------
 * Page memory: search, filters and tab survive a trip to a recipe and back (this session only).
 * ---------------------------------------------------------------------------------------------- */

export interface LibrarySessionState {
  query: string;
  filters: LibraryFilterKey[];
  tab: LibraryTab;
}

let sessionState: LibrarySessionState = { filters: [], query: "", tab: "personal" };

export const getLibrarySessionState = (): LibrarySessionState => sessionState;

export const setLibrarySessionState = (next: LibrarySessionState): void => {
  sessionState = next;
};

export const resetLibrarySessionStateForTests = (): void => {
  sessionState = { filters: [], query: "", tab: "personal" };
};
