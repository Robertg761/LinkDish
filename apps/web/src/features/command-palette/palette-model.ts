import { extractFirstUrl, highlightRanges } from "@linkdish/recipe-domain";

import type { IconName } from "../../components/Icon";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { HighlightRange } from "@linkdish/recipe-domain";

/**
 * What the command palette shows for a query: pure, so it is easy to test. The component owns
 * searching (the recipe index), rendering and running the chosen action.
 */

export type PaletteAction =
  | { type: "open-recipe"; recipeId: string }
  | { type: "cook-recipe"; recipeId: string }
  | { type: "navigate"; to: string; analytics: string }
  | { type: "import-url"; url: string }
  | { type: "add-shopping"; text: string }
  | { type: "set-theme"; theme: "light" | "dark" }
  | { type: "show-shortcuts" };

export type PaletteGroupId = "recipes" | "goto" | "actions";

export interface PaletteItem {
  id: string;
  group: PaletteGroupId;
  label: string;
  /** Marked parts of the label (matches for the query). */
  highlights: HighlightRange[];
  description?: string | undefined;
  icon: IconName;
  /** Recipe rows show the photo instead of an icon. */
  recipe?: WebSavedRecipe | undefined;
  /** Key caps shown on the right on desktop, e.g. ["G", "C"]. */
  shortcut?: readonly string[] | undefined;
  action: PaletteAction;
  /** Shift+Enter (and the row's Cook button). */
  secondaryAction?: PaletteAction | undefined;
}

export interface PaletteSection {
  id: PaletteGroupId;
  label: string;
  items: PaletteItem[];
}

interface StaticEntry {
  id: string;
  label: string;
  icon: IconName;
  keywords: string;
  description?: string;
  shortcut?: readonly string[];
  action: PaletteAction;
}

export const GO_TO_ENTRIES: readonly StaticEntry[] = [
  {
    action: { analytics: "cookbook", to: "/", type: "navigate" },
    icon: "book-open",
    id: "goto-cookbook",
    keywords: "home library recipes saved",
    label: "Cookbook",
    shortcut: ["G", "C"]
  },
  {
    action: { analytics: "plan", to: "/plan", type: "navigate" },
    icon: "calendar-days",
    id: "goto-plan",
    keywords: "meal plan week calendar dinner",
    label: "Meal plan",
    shortcut: ["G", "P"]
  },
  {
    action: { analytics: "shopping", to: "/shopping", type: "navigate" },
    icon: "shopping-basket",
    id: "goto-shopping",
    keywords: "shopping list groceries store",
    label: "Shopping list",
    shortcut: ["G", "S"]
  },
  {
    action: { analytics: "settings", to: "/settings", type: "navigate" },
    icon: "settings",
    id: "goto-settings",
    keywords: "preferences theme units dark mode export backup",
    label: "Settings"
  },
  {
    action: { analytics: "account", to: "/account", type: "navigate" },
    icon: "circle-user",
    id: "goto-account",
    keywords: "you profile sign in log in sign out",
    label: "Account"
  },
  {
    action: { analytics: "pricing", to: "/pricing", type: "navigate" },
    icon: "crown",
    id: "goto-pricing",
    keywords: "plans pricing upgrade plus family billing subscription",
    label: "Plans & pricing"
  },
  {
    action: { analytics: "install", to: "/install", type: "navigate" },
    icon: "smartphone-download",
    id: "goto-install",
    keywords: "install app download phone home screen",
    label: "Install the app"
  },
  {
    action: { analytics: "household", to: "/household", type: "navigate" },
    icon: "users",
    id: "goto-household",
    keywords: "household family share invite members",
    label: "Household"
  }
];

const ACTION_ENTRIES: readonly StaticEntry[] = [
  {
    action: { analytics: "new_import", to: "/import", type: "navigate" },
    description: "Paste a link, recipe text or a photo",
    icon: "plus",
    id: "action-new-import",
    keywords: "new import add recipe save paste link url photo scan",
    label: "Add a recipe",
    shortcut: ["N"]
  },
  {
    action: { analytics: "plan_week", to: "/plan", type: "navigate" },
    description: "Pick dinners for the days ahead",
    icon: "calendar-plus",
    id: "action-plan-week",
    keywords: "plan this week meal plan dinners schedule",
    label: "Plan this week"
  },
  {
    action: { type: "show-shortcuts" },
    icon: "keyboard",
    id: "action-shortcuts",
    keywords: "keyboard shortcuts keys help hotkeys",
    label: "Keyboard shortcuts",
    shortcut: ["?"]
  }
];

const RECENT_LIMIT = 5;
const RECIPE_RESULT_LIMIT = 6;
const MAX_SHOPPING_TEXT = 80;

export const foldText = (text: string): string =>
  text.normalize("NFKD").replace(/[̀-ͯ]/gu, "").toLowerCase();

/** Every query word starts a word in the label or keywords ("sho li" finds Shopping list). */
export const matchesEntry = (entry: Pick<StaticEntry, "label" | "keywords">, query: string) => {
  const words = foldText(`${entry.label} ${entry.keywords}`).split(/[^\p{L}\p{N}]+/u);
  const terms = foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  return terms.length > 0 && terms.every((term) => words.some((word) => word.startsWith(term)));
};

const toItem = (entry: StaticEntry, group: PaletteGroupId, query: string): PaletteItem => ({
  action: entry.action,
  description: entry.description,
  group,
  highlights: query ? highlightRanges(entry.label, query) : [],
  icon: entry.icon,
  id: entry.id,
  label: entry.label,
  shortcut: entry.shortcut
});

const openedAt = (recipe: WebSavedRecipe): number => {
  const time = Date.parse(recipe.lastOpenedAt ?? "");
  return Number.isFinite(time) ? time : 0;
};

/** Recently opened first; recipes never opened fall back to the newest saves. */
export const pickRecentRecipes = (
  recipes: readonly WebSavedRecipe[],
  limit = RECENT_LIMIT
): WebSavedRecipe[] => {
  const opened = recipes
    .filter((recipe) => openedAt(recipe) > 0)
    .sort((a, b) => openedAt(b) - openedAt(a));

  if (opened.length >= limit) {
    return opened.slice(0, limit);
  }

  const openedIds = new Set(opened.map((recipe) => recipe.id));
  const rest = recipes.filter((recipe) => !openedIds.has(recipe.id));

  return [...opened, ...rest].slice(0, limit);
};

const recipeItem = (
  recipe: WebSavedRecipe,
  query: string,
  describe: (recipe: WebSavedRecipe) => string | undefined
): PaletteItem => ({
  action: { recipeId: recipe.id, type: "open-recipe" },
  description: describe(recipe),
  group: "recipes",
  highlights: query ? highlightRanges(recipe.recipe.title, query) : [],
  icon: "book-open",
  id: `recipe-${recipe.id}`,
  label: recipe.recipe.title,
  recipe,
  secondaryAction: { recipeId: recipe.id, type: "cook-recipe" }
});

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** "seriouseats.com/recipes/…" — short enough for one line. */
export const describeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return clip(`${parsed.hostname.replace(/^www\./u, "")}${path}`, 60);
  } catch {
    return clip(url, 60);
  }
};

export interface RecipeMatch {
  recipe: WebSavedRecipe;
  /** The query matched the title (not only ingredients, notes or steps). */
  titleMatch: boolean;
}

export interface BuildPaletteOptions {
  query: string;
  recipes: readonly WebSavedRecipe[];
  /** Ranked matches for a non-empty query (the recipe search index). */
  searchRecipes: (query: string, limit: number) => RecipeMatch[];
  /** The theme on screen now; the palette offers the other one. */
  resolvedTheme: "light" | "dark";
  describeRecipe?: ((recipe: WebSavedRecipe) => string | undefined) | undefined;
}

export const buildPaletteSections = ({
  describeRecipe = () => undefined,
  query: rawQuery,
  recipes,
  resolvedTheme,
  searchRecipes
}: BuildPaletteOptions): PaletteSection[] => {
  const query = rawQuery.trim();
  const url = query ? extractFirstUrl(query) : null;
  const themeEntry: StaticEntry =
    resolvedTheme === "dark"
      ? {
          action: { theme: "light", type: "set-theme" },
          icon: "sun",
          id: "action-theme",
          keywords: "theme light mode appearance bright switch",
          label: "Switch to light theme"
        }
      : {
          action: { theme: "dark", type: "set-theme" },
          icon: "moon",
          id: "action-theme",
          keywords: "theme dark mode appearance night switch",
          label: "Switch to dark theme"
        };
  const actionEntries = [
    ACTION_ENTRIES[0],
    ACTION_ENTRIES[1],
    themeEntry,
    ACTION_ENTRIES[2]
  ].filter((entry): entry is StaticEntry => Boolean(entry));

  if (!query) {
    const recent = pickRecentRecipes(recipes);

    return [
      {
        id: "recipes" as const,
        items: recent.map((recipe) => recipeItem(recipe, "", describeRecipe)),
        label: "Recent recipes"
      },
      {
        id: "goto" as const,
        items: GO_TO_ENTRIES.map((entry) => toItem(entry, "goto", "")),
        label: "Go to"
      },
      {
        id: "actions" as const,
        items: actionEntries.map((entry) => toItem(entry, "actions", "")),
        label: "Actions"
      }
    ].filter((section) => section.items.length > 0);
  }

  if (url) {
    // A pasted link: importing it is almost certainly the point.
    return [
      {
        id: "actions",
        items: [
          {
            action: { type: "import-url", url },
            description: describeUrl(url),
            group: "actions",
            highlights: [],
            icon: "link",
            id: "action-import-url",
            label: "Import this recipe"
          }
        ],
        label: "Actions"
      }
    ];
  }

  const recipeMatches = searchRecipes(query, RECIPE_RESULT_LIMIT);
  const recipeItems = recipeMatches.map((match) => recipeItem(match.recipe, query, describeRecipe));
  const gotoItems = GO_TO_ENTRIES.filter((entry) => matchesEntry(entry, query)).map((entry) =>
    toItem(entry, "goto", query)
  );
  const matchedActions = actionEntries
    .filter((entry) => matchesEntry(entry, query))
    .map((entry) => toItem(entry, "actions", query));
  const shoppingText = clip(query.replace(/\s+/gu, " "), MAX_SHOPPING_TEXT);
  const shoppingItem: PaletteItem = {
    action: { text: shoppingText, type: "add-shopping" },
    group: "actions",
    highlights: [],
    icon: "list-plus",
    id: "action-add-shopping",
    label: `Add “${shoppingText}” to the shopping list`
  };

  const recipeSection: PaletteSection = { id: "recipes", items: recipeItems, label: "Recipes" };
  const goto: PaletteSection = { id: "goto", items: gotoItems, label: "Go to" };
  const actions: PaletteSection = {
    id: "actions",
    items: [...matchedActions, shoppingItem],
    label: "Actions"
  };
  // "pla" means Meal plan, not a recipe that mentions "place" in a step: when no recipe title
  // matches but a page or command does, the commands come first.
  const commandsFirst =
    gotoItems.length + matchedActions.length > 0 &&
    !recipeMatches.some((match) => match.titleMatch);
  const ordered = commandsFirst ? [goto, actions, recipeSection] : [recipeSection, goto, actions];

  return ordered.filter((section) => section.items.length > 0);
};

export const flattenSections = (sections: readonly PaletteSection[]): PaletteItem[] =>
  sections.flatMap((section) => section.items);

/** Index of the first item of the next (or previous) group, wrapping around. */
export const stepGroup = (
  sections: readonly PaletteSection[],
  activeIndex: number,
  direction: 1 | -1
): number => {
  const starts: number[] = [];
  let offset = 0;

  for (const section of sections) {
    starts.push(offset);
    offset += section.items.length;
  }

  if (starts.length === 0) {
    return 0;
  }

  let current = 0;

  starts.forEach((start, index) => {
    if (activeIndex >= start) {
      current = index;
    }
  });

  const next = (current + direction + starts.length) % starts.length;
  return starts[next] ?? 0;
};
