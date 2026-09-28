import { describe, expect, it } from "vitest";

import {
  buildPaletteSections,
  describeUrl,
  flattenSections,
  GO_TO_ENTRIES,
  matchesEntry,
  pickRecentRecipes,
  stepGroup
} from "./palette-model";

import type { RecipeMatch } from "./palette-model";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

const recipe = (id: string, title: string, extra: Partial<WebSavedRecipe> = {}): WebSavedRecipe =>
  ({
    createdAt: "2026-09-01T00:00:00.000Z",
    id,
    recipe: {
      cookTimeMinutes: null,
      image: null,
      ingredients: [{ text: "1 lemon" }],
      nutrition: null,
      prepTimeMinutes: null,
      servings: "4",
      sourceType: "recipe-webpage",
      sourceUrl: `https://example.com/${id}`,
      steps: [{ index: 1, text: "Cook." }],
      title
    },
    sourceHost: "example.com",
    sourceUrl: `https://example.com/${id}`,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...extra
  }) as unknown as WebSavedRecipe;

const recipes = [
  recipe("a", "Lemon Chicken", { lastOpenedAt: "2026-09-20T10:00:00.000Z" }),
  recipe("b", "Tomato Soup"),
  recipe("c", "Banana Bread", { lastOpenedAt: "2026-09-25T10:00:00.000Z" }),
  recipe("d", "Pad Thai")
];

const noSearch = (): RecipeMatch[] => [];

describe("palette model", () => {
  it("shows recent recipes, destinations and actions for an empty query", () => {
    const sections = buildPaletteSections({
      query: "  ",
      recipes,
      resolvedTheme: "light",
      searchRecipes: noSearch
    });

    expect(sections.map((section) => section.label)).toEqual([
      "Recent recipes",
      "Go to",
      "Actions"
    ]);
    // Most recently opened first, then the newest saves fill in.
    expect(sections[0]?.items.map((item) => item.label)).toEqual([
      "Banana Bread",
      "Lemon Chicken",
      "Tomato Soup",
      "Pad Thai"
    ]);
    expect(sections[0]?.items[0]).toMatchObject({
      action: { recipeId: "c", type: "open-recipe" },
      secondaryAction: { recipeId: "c", type: "cook-recipe" }
    });
    expect(sections[1]?.items.map((item) => item.label)).toEqual(
      GO_TO_ENTRIES.map((entry) => entry.label)
    );
    expect(sections[2]?.items.map((item) => item.label)).toEqual([
      "Add a recipe",
      "Plan this week",
      "Switch to dark theme",
      "Keyboard shortcuts"
    ]);
  });

  it("offers the other theme", () => {
    const actions = buildPaletteSections({
      query: "",
      recipes: [],
      resolvedTheme: "dark",
      searchRecipes: noSearch
    }).find((section) => section.id === "actions");

    expect(actions?.items.find((item) => item.id === "action-theme")).toMatchObject({
      action: { theme: "light", type: "set-theme" },
      label: "Switch to light theme"
    });
  });

  it("skips the recipe group when the cookbook is empty", () => {
    const sections = buildPaletteSections({
      query: "",
      recipes: [],
      resolvedTheme: "light",
      searchRecipes: noSearch
    });

    expect(sections.map((section) => section.id)).toEqual(["goto", "actions"]);
  });

  it("turns a pasted link into an import", () => {
    const sections = buildPaletteSections({
      query: "check this out www.seriouseats.com/best-chili?utm_source=x",
      recipes,
      resolvedTheme: "light",
      searchRecipes: () => {
        throw new Error("links are not searched");
      }
    });

    expect(flattenSections(sections)).toEqual([
      expect.objectContaining({
        action: { type: "import-url", url: "https://www.seriouseats.com/best-chili?utm_source=x" },
        description: "seriouseats.com/best-chili",
        label: "Import this recipe"
      })
    ]);
  });

  it("lists matching recipes first with highlights, then pages, actions and a shopping add", () => {
    const sections = buildPaletteSections({
      query: "lemon",
      recipes,
      resolvedTheme: "light",
      searchRecipes: (query, limit) => {
        expect([query, limit]).toEqual(["lemon", 6]);
        return [{ recipe: recipes[0]!, titleMatch: true }];
      }
    });

    expect(sections.map((section) => section.id)).toEqual(["recipes", "actions"]);
    expect(sections[0]?.items[0]).toMatchObject({
      highlights: [{ end: 5, start: 0 }],
      label: "Lemon Chicken"
    });
    expect(sections[1]?.items.at(-1)).toMatchObject({
      action: { text: "lemon", type: "add-shopping" },
      label: "Add “lemon” to the shopping list"
    });
  });

  it("puts pages and commands first when no recipe title matches", () => {
    const sections = buildPaletteSections({
      query: "pla",
      recipes,
      resolvedTheme: "light",
      searchRecipes: () => [{ recipe: recipes[3]!, titleMatch: false }]
    });

    expect(sections.map((section) => section.id)).toEqual(["goto", "actions", "recipes"]);
    expect(sections[0]?.items.map((item) => item.label)).toEqual(["Meal plan", "Plans & pricing"]);
    expect(sections[0]?.items[0]?.highlights).toEqual([{ end: 8, start: 5 }]);
    expect(sections[1]?.items[0]?.label).toBe("Plan this week");
  });

  it("matches word prefixes in labels and keywords, ignoring accents", () => {
    const shopping = GO_TO_ENTRIES.find((entry) => entry.id === "goto-shopping")!;

    expect(matchesEntry(shopping, "sho li")).toBe(true);
    expect(matchesEntry(shopping, "GROCER")).toBe(true);
    expect(matchesEntry(shopping, "list shop")).toBe(true);
    expect(matchesEntry(shopping, "opping")).toBe(false);
    expect(matchesEntry({ keywords: "", label: "Crème brûlée" }, "creme bru")).toBe(true);
  });

  it("steps between groups with Tab, wrapping around", () => {
    const sections = buildPaletteSections({
      query: "",
      recipes,
      resolvedTheme: "light",
      searchRecipes: noSearch
    });
    const gotoStart = 4;
    const actionsStart = 4 + GO_TO_ENTRIES.length;

    expect(stepGroup(sections, 0, 1)).toBe(gotoStart);
    expect(stepGroup(sections, gotoStart + 2, 1)).toBe(actionsStart);
    expect(stepGroup(sections, actionsStart, 1)).toBe(0);
    expect(stepGroup(sections, 0, -1)).toBe(actionsStart);
    expect(stepGroup([], 0, 1)).toBe(0);
  });

  it("opens the text and photo importers directly when searched for", () => {
    const find = (query: string, id: string) =>
      flattenSections(
        buildPaletteSections({ query, recipes, resolvedTheme: "light", searchRecipes: noSearch })
      ).find((item) => item.id === id);

    expect(find("paste text", "action-paste-text")).toMatchObject({
      action: { to: "/import?tab=text", type: "navigate" },
      label: "Paste a recipe's text"
    });
    expect(find("scan photo", "action-scan-photo")).toMatchObject({
      action: { to: "/import?tab=photos", type: "navigate" },
      label: "Scan a recipe photo"
    });
  });

  it("keeps recents to five and link descriptions short", () => {
    const many = Array.from({ length: 8 }, (_, index) => recipe(`r${index}`, `Recipe ${index}`));

    expect(pickRecentRecipes(many)).toHaveLength(5);
    expect(describeUrl("https://www.example.com/")).toBe("example.com");
    expect(describeUrl(`https://example.com/${"x".repeat(80)}`)).toHaveLength(60);
  });
});
