import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  getCachedSavedRecipe,
  loadSavedRecipes,
  resetLibraryStoreForTests,
  setTags
} from "../../data/library-store";
import {
  getLinkDishWebDb,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { isolateFakeIdbTransactions } from "../../storage/testing/fake-idb-isolation";
import { writeInOtherTabAfterNextRead } from "../../storage/testing/two-tabs";

import {
  duplicateSavedRecipe,
  forceSaveRecipe,
  generateDeterministicId,
  LOCAL_LIMIT_FREE,
  putSavedRecipe,
  restoreSavedRecipe,
  saveRecipe,
  SavedRecipeLimitError,
  updateSavedRecipe
} from "./saved-recipe-store";

import type { SaveRecipeInput } from "./saved-recipe-store";
import type { WebSavedRecipe } from "./saved-recipe-types";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock(
  "idb",
  async () => (await import("../../storage/testing/fake-idb-isolation")).isolatingFakeIdbModule
);

vi.mock("../../api/client", () => ({ apiClient: {} }));

vi.mock("../../analytics/client", () => ({ trackWebEvent: vi.fn() }));

/** Another tab on the same database: fresh copies of the connection, change feed and caches. */
const openOtherTab = async () => {
  vi.resetModules();
  const feed = await import("../../data/change-feed");
  const library = await import("../../data/library-store");
  const store = await import("./saved-recipe-store");
  const connection = await (await import("../../storage/linkdish-db")).getLinkDishWebDb();
  feed.setDataChannelFactoryForTests(() => null);
  return { connection, library, store };
};

const recipeContent = (title: string): Recipe =>
  ({
    cookTimeMinutes: null,
    ingredients: [{ text: "1 cup rice" }],
    nutrition: null,
    prepTimeMinutes: null,
    servings: "2",
    sourceType: "recipe-webpage",
    sourceUrl: `https://example.com/${encodeURIComponent(title)}`,
    steps: [{ index: 1, text: "Cook." }],
    title
  }) as unknown as Recipe;

const saveInput = (title: string): SaveRecipeInput => {
  const recipe = recipeContent(title);
  return {
    extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
    recipe,
    sourceUrl: recipe.sourceUrl
  };
};

const personalRecipe = (id: string): WebSavedRecipe => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
  id,
  recipe: recipeContent(id),
  sourceHost: "example.com",
  sourceUrl: `https://example.com/${id}`,
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-09-01T00:00:00.000Z"
});

/** Fills a free cookbook up to one below the limit. */
const fillToOneBelowLimit = () =>
  fakeIdb.seed(
    SAVED_RECIPES_STORE_NAME,
    Array.from({ length: LOCAL_LIMIT_FREE - 1 }, (_, index) => personalRecipe(`mine-${index}`))
  );

const stored = (id: string) => fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id);

const personalCount = () =>
  fakeIdb
    .records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME)
    .filter((recipe) => !recipe.id.startsWith("starter-")).length;

describe("saved-recipe writes from two tabs", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    isolateFakeIdbTransactions();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    setDataChannelFactoryForTests(() => null);
    localStorage.clear();
    await getLinkDishWebDb();
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a favorite the other tab sets while this one re-imports the recipe", async () => {
    const input = saveInput("Fried rice");
    const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);
    await putSavedRecipe({ ...personalRecipe(id), notes: "Use day-old rice" });
    const other = await openOtherTab();

    const favorited = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      SAVED_RECIPES_STORE_NAME,
      id,
      other.connection,
      () => other.store.setRecipeFavorite(id, true)
    );

    await Promise.all([
      forceSaveRecipe({ ...input, recipe: { ...input.recipe, servings: "4" } }),
      favorited
    ]);

    expect(stored(id)).toMatchObject({
      favorite: true,
      notes: "Use day-old rice",
      recipe: { servings: "4" }
    });
  });

  it("keeps a cook the other tab logs while this one saves an edit with a new link", async () => {
    await putSavedRecipe(personalRecipe("soup"));
    const other = await openOtherTab();

    const cooked = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      SAVED_RECIPES_STORE_NAME,
      "soup",
      other.connection,
      () => other.store.logRecipeCooked("soup", { cookedAt: "2026-09-27T18:00:00.000Z" })
    );

    // The recipe page used to save the link in a second write, over the record the edit returned.
    await Promise.all([
      updateSavedRecipe("soup", {
        notes: "Less salt",
        recipe: { ...recipeContent("soup"), servings: "6" },
        sourceUrl: "https://cooking.example/soup"
      }),
      cooked
    ]);

    expect(stored("soup")).toMatchObject({
      cookLog: [{ cookedAt: "2026-09-27T18:00:00.000Z" }],
      notes: "Less salt",
      recipe: { servings: "6" },
      sourceHost: "cooking.example",
      sourceUrl: "https://cooking.example/soup",
      timesCooked: 1
    });
  });

  it("lets only one tab save the same new recipe", async () => {
    const other = await openOtherTab();
    const input = saveInput("Fried rice");

    const results = await Promise.all([
      saveRecipe(input, false),
      other.store.saveRecipe(input, false)
    ]);

    expect(results.map((result) => result.error ?? "saved").sort()).toEqual([
      "duplicate_prompt",
      "saved"
    ]);
  });

  it("never lets two tabs save past the free limit", async () => {
    fillToOneBelowLimit();
    const other = await openOtherTab();

    const results = await Promise.all([
      saveRecipe(saveInput("Fried rice"), false),
      other.store.saveRecipe(saveInput("Congee"), false)
    ]);

    expect(results.map((result) => result.error ?? "saved").sort()).toEqual([
      "limit_exceeded",
      "saved"
    ]);
    expect(personalCount()).toBe(LOCAL_LIMIT_FREE);
  });

  it("restores a deleted recipe only while the free cookbook has room", async () => {
    fillToOneBelowLimit();
    const other = await openOtherTab();

    const [restored, saved] = await Promise.allSettled([
      restoreSavedRecipe(personalRecipe("deleted"), { isPremiumUser: false }),
      other.store.saveRecipe(saveInput("Congee"), false)
    ]);

    expect([
      restored.status === "fulfilled" ? "restored" : restored.reason,
      saved.status === "fulfilled" ? (saved.value.error ?? "saved") : saved.reason
    ]).toEqual(
      restored.status === "fulfilled"
        ? ["restored", "limit_exceeded"]
        : [expect.any(SavedRecipeLimitError), "saved"]
    );
    expect(personalCount()).toBe(LOCAL_LIMIT_FREE);
  });

  it("never lets two tabs duplicate past the free limit", async () => {
    fillToOneBelowLimit();
    const other = await openOtherTab();

    const outcomes = await Promise.allSettled([
      duplicateSavedRecipe("mine-0", { isPremiumUser: false }),
      other.store.duplicateSavedRecipe("mine-1", { isPremiumUser: false })
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      // Either tab's copy of the error class (each tab has its own modules).
      { reason: expect.objectContaining({ code: "limit_exceeded" }) as unknown, status: "rejected" }
    ]);
    expect(personalCount()).toBe(LOCAL_LIMIT_FREE);
  });

  it("keeps a tag the other tab adds while this tab's cookbook is out of date", async () => {
    await putSavedRecipe({ ...personalRecipe("tacos"), tags: ["Quick"] });
    await loadSavedRecipes();
    const other = await openOtherTab();
    await other.library.loadSavedRecipes();

    // Both tag editors add a tag while each shows only "Quick". (They used to save the tags they
    // showed plus the new one, so the later save dropped the other tab's tag.)
    await Promise.all([
      setTags("tacos", (tags) => [...tags, "Spicy"]),
      other.library.setTags("tacos", (tags) => [...tags, "Weeknight"])
    ]);

    expect([...(stored("tacos")?.tags ?? [])].sort()).toEqual(["Quick", "Spicy", "Weeknight"]);
    expect(getCachedSavedRecipe("tacos")?.tags).toContain("Spicy");
  });
});
