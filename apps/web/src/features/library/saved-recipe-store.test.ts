import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { resetDataChangeFeedForTests, subscribeDataChanges } from "../../data/change-feed";
import {
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import {
  LOCAL_LIMIT_FREE,
  saveRecipe,
  countSavedRecipes,
  countQuotaSavedRecipes,
  deleteSavedRecipe,
  duplicateSavedRecipe,
  forceSaveRecipe,
  generateDeterministicId,
  getDb,
  getSavedRecipeById,
  getSavedRecipes,
  getSavedRecipeSourceImages,
  getSourceHost,
  incrementSavedRecipeTimesCooked,
  logRecipeCooked,
  markRecipeOpened,
  normalizeRecipeTags,
  removeCollectionFromAllRecipes,
  saveSharedRecipeCopy,
  SavedRecipeLimitError,
  seedStarterRecipesIfNeeded,
  setRecipeCollections,
  setRecipeFavorite,
  setRecipePreferredServings,
  setRecipeRating,
  setRecipeTags,
  syncRecipeToHousehold,
  updateRecipeNotes,
  updateSavedRecipe
} from "./saved-recipe-store";

import type { SharedRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";
import type * as RecipeDomain from "@linkdish/recipe-domain";

const starterSeedMocks = vi.hoisted(() => ({ fail: false }));

const apiMocks = vi.hoisted(() => ({
  createSharedRecipe: vi.fn(),
  getHousehold: vi.fn(),
  updateSharedRecipe: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: apiMocks
}));

vi.mock("@linkdish/recipe-domain", async (importOriginal) => {
  const actual = await importOriginal<typeof RecipeDomain>();

  return {
    ...actual,
    createStarterRecipeSeedRecords: () => {
      if (starterSeedMocks.fail) {
        throw new Error("starter seed unavailable");
      }

      return actual.createStarterRecipeSeedRecords();
    }
  };
});

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const mockStore = {
  set: (_key: string, value: unknown) => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [value]);
  }
};

const dummyRecipe: Recipe = {
  title: "Grandma's Cookies",
  sourceUrl: "https://example.com/cookies",
  sourceType: "recipe-webpage",
  ingredients: [{ text: "1 cup sugar" }],
  steps: [{ index: 1, text: "Mix and bake" }],
  servings: "12",
  prepTimeMinutes: 10,
  cookTimeMinutes: 12,
  nutrition: null,
  confidence: {
    score: 0.95,
    summary: "High confidence",
    missingFields: [],
    notes: [],
    fieldProvenance: {
      title: "jsonld",
      ingredients: "jsonld",
      steps: "jsonld",
      servings: "jsonld",
      prepTimeMinutes: "jsonld",
      cookTimeMinutes: "jsonld",
      nutrition: null
    }
  }
};

const createSaveInput = (index: number) => ({
  recipe: {
    ...dummyRecipe,
    title: `${dummyRecipe.title} ${index}`,
    sourceUrl: `https://example.com/cookies-${index}`
  },
  sourceUrl: `https://example.com/cookies-${index}`,
  extraction: {
    fetchMode: "http" as const,
    provenance: ["jsonld" as const],
    strategy: "recipe-schema" as const,
    warnings: []
  }
});

describe("saved-recipe-store", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    // Open once so the v4 schema exists before tests seed legacy records.
    await getDb();
    localStorage.clear();
    starterSeedMocks.fail = false;
  });

  const activeSpies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    activeSpies.splice(0).forEach((spy) => {
      spy.mockRestore();
    });
  });

  it("opens v1 records under the v4 IndexedDB schema with missing images treated as null", async () => {
    const legacyRecipe = { ...dummyRecipe };
    delete legacyRecipe.image;
    mockStore.set("legacy-recipe", {
      createdAt: "2026-07-01T00:00:00.000Z",
      extraction: {
        fetchMode: "http",
        provenance: ["jsonld"],
        strategy: "recipe-schema",
        warnings: []
      },
      id: "legacy-recipe",
      recipe: legacyRecipe,
      sourceHost: "example.com",
      sourceUrl: legacyRecipe.sourceUrl,
      updatedAt: "2026-07-01T00:00:00.000Z"
    });

    await getDb();
    const stored = await getSavedRecipeById("legacy-recipe");

    expect(fakeIdb.openCalls).toEqual([{ name: "linkdish-web", version: 4 }]);
    expect(stored?.recipe.image ?? null).toBeNull();
    expect(stored?.recipe.title).toBe("Grandma's Cookies");
  });

  it("should generate deterministic IDs based on source URL and title", async () => {
    const id1 = await generateDeterministicId("https://example.com/cookies", "Grandma's Cookies");
    const id2 = await generateDeterministicId("https://example.com/cookies", "Grandma's Cookies");
    const id3 = await generateDeterministicId(
      "https://example.com/cookies",
      "Grandma's Different Cookies"
    );

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("should save a new recipe and count it", async () => {
    const res = await saveRecipe(
      {
        recipe: dummyRecipe,
        sourceUrl: "https://example.com/cookies",
        extraction: {
          fetchMode: "http",
          provenance: ["jsonld"],
          strategy: "recipe-schema",
          warnings: []
        }
      },
      true // is premium
    );

    expect(res.success).toBe(true);
    expect(res.recipe).toBeDefined();
    expect(res.recipe?.recipe.title).toBe("Grandma's Cookies");

    const count = await countSavedRecipes();
    expect(count).toBe(1);
  });

  it("increments timesCooked from the additive default", async () => {
    const res = await saveRecipe(
      {
        recipe: dummyRecipe,
        sourceUrl: "https://example.com/cookies",
        extraction: {
          fetchMode: "http",
          provenance: ["jsonld"],
          strategy: "recipe-schema",
          warnings: []
        }
      },
      true
    );

    expect(res.recipe?.timesCooked).toBe(0);

    const updatedRecipe = await incrementSavedRecipeTimesCooked(res.recipe?.id ?? "");

    expect(updatedRecipe?.timesCooked).toBe(1);
    expect((await getSavedRecipeById(res.recipe?.id ?? ""))?.timesCooked).toBe(1);
  });

  it("seeds starter recipes once without counting them toward save quota", async () => {
    await seedStarterRecipesIfNeeded();

    expect(await countSavedRecipes()).toBe(3);
    expect(await countQuotaSavedRecipes()).toBe(0);
    expect(localStorage.getItem("linkdish:web:starter-recipes-seeded:v1")).toBe("true");

    await seedStarterRecipesIfNeeded();
    expect(await countSavedRecipes()).toBe(3);
  });

  it("marks existing libraries as seeded without backfilling starters", async () => {
    mockStore.set("existing-recipe", {
      id: "existing-recipe",
      recipe: dummyRecipe,
      sourceHost: "example.com",
      sourceUrl: dummyRecipe.sourceUrl,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      extraction: {
        fetchMode: "http",
        provenance: ["jsonld"],
        strategy: "recipe-schema",
        warnings: []
      }
    });

    await seedStarterRecipesIfNeeded();

    expect(await countSavedRecipes()).toBe(1);
    expect(await countQuotaSavedRecipes()).toBe(1);
    expect(localStorage.getItem("linkdish:web:starter-recipes-seeded:v1")).toBe("true");
  });

  it("should prevent duplicate saves and prompt instead", async () => {
    const saveInput = {
      recipe: dummyRecipe,
      sourceUrl: "https://example.com/cookies",
      extraction: {
        fetchMode: "http" as const,
        provenance: ["jsonld" as const],
        strategy: "recipe-schema" as const,
        warnings: []
      }
    };

    // First save
    await saveRecipe(saveInput, true);

    // Second save should return duplicate indicator
    const res = await saveRecipe(saveInput, true);
    expect(res.success).toBe(false);
    expect(res.error).toBe("duplicate_prompt");
  });

  it("lets free users save up to 15 personal recipes", async () => {
    for (let i = 0; i < LOCAL_LIMIT_FREE; i += 1) {
      const res = await saveRecipe(createSaveInput(i), false);
      expect(res.success).toBe(true);
    }

    expect(await countSavedRecipes()).toBe(LOCAL_LIMIT_FREE);
    expect(await countQuotaSavedRecipes()).toBe(LOCAL_LIMIT_FREE);
  });

  it("fires the free save limit on the 16th personal recipe", async () => {
    for (let i = 0; i < LOCAL_LIMIT_FREE; i += 1) {
      await saveRecipe(createSaveInput(i), false);
    }

    const res = await saveRecipe(createSaveInput(LOCAL_LIMIT_FREE), false);
    expect(res.success).toBe(false);
    expect(res.error).toBe("limit_exceeded");
    expect(await countSavedRecipes()).toBe(LOCAL_LIMIT_FREE);
  });

  it("excludes starter recipes from the free save limit", async () => {
    await seedStarterRecipesIfNeeded();

    for (let i = 0; i < LOCAL_LIMIT_FREE; i += 1) {
      const res = await saveRecipe(createSaveInput(i), false);
      expect(res.success).toBe(true);
    }

    const blocked = await saveRecipe(createSaveInput(LOCAL_LIMIT_FREE), false);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe("limit_exceeded");
    expect(await countSavedRecipes()).toBe(LOCAL_LIMIT_FREE + 3);
    expect(await countQuotaSavedRecipes()).toBe(LOCAL_LIMIT_FREE);
  });

  it("should bypass the free saved recipe limit if user is premium", async () => {
    for (let i = 0; i < 10; i++) {
      mockStore.set(`id-${i}`, { id: `id-${i}`, recipe: { title: `Recipe ${i}` } });
    }

    const res = await saveRecipe(
      {
        recipe: dummyRecipe,
        sourceUrl: "https://example.com/cookies-eleven",
        extraction: {
          fetchMode: "http",
          provenance: ["jsonld"],
          strategy: "recipe-schema",
          warnings: []
        }
      },
      true // is premium
    );

    expect(res.success).toBe(true);
    expect(await countSavedRecipes()).toBe(11);
  });

  it("does not mark starter recipes as seeded when seeding fails", async () => {
    starterSeedMocks.fail = true;

    await expect(seedStarterRecipesIfNeeded()).rejects.toThrow("starter seed unavailable");
    expect(localStorage.getItem("linkdish:web:starter-recipes-seeded:v1")).toBeNull();
    expect(await countSavedRecipes()).toBe(0);

    starterSeedMocks.fail = false;
    await seedStarterRecipesIfNeeded();

    expect(await countSavedRecipes()).toBe(3);
    expect(localStorage.getItem("linkdish:web:starter-recipes-seeded:v1")).toBe("true");
  });

  it("still seeds starter recipes when localStorage refuses writes", async () => {
    activeSpies.push(
      vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      })
    );

    await expect(seedStarterRecipesIfNeeded()).resolves.toBeUndefined();
    expect(await countSavedRecipes()).toBe(3);
  });

  it("exposes a source host helper that tolerates malformed URLs", () => {
    expect(getSourceHost("https://www.example.com/recipes/1")).toBe("example.com");
    expect(getSourceHost("not a url")).toBe("unknown");
    expect(getSourceHost("")).toBe("unknown");
  });
});

const scan = (index: number) => ({
  dataUrl: `data:image/jpeg;base64,${"B".repeat(32)}${index}`,
  mimeType: "image/jpeg" as const
});

describe("saved-recipe-store v4 behaviour", () => {
  let uuidCounter = 0;

  beforeEach(async () => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    localStorage.clear();
    starterSeedMocks.fail = false;
    uuidCounter = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
    });
    apiMocks.createSharedRecipe.mockReset();
    apiMocks.getHousehold.mockReset();
    apiMocks.updateSharedRecipe.mockReset();
    await getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const saveScanned = async () => {
    const res = await saveRecipe({ ...createSaveInput(1), sourceImages: [scan(1), scan(2)] }, true);
    return res.recipe!;
  };

  it("keeps source images out of list reads and hydrates them for the detail read", async () => {
    const saved = await saveScanned();

    expect(saved.sourceImages).toEqual([scan(1), scan(2)]);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, saved.id)).not.toHaveProperty("sourceImages");
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, saved.id)).toMatchObject({
      images: [scan(1), scan(2)],
      recipeId: saved.id
    });

    const [listed] = await getSavedRecipes();
    expect(listed).not.toHaveProperty("sourceImages");
    expect(listed?.sourceImageCount).toBe(2);

    expect((await getSavedRecipeById(saved.id))?.sourceImages).toEqual([scan(1), scan(2)]);
    expect(await getSavedRecipeSourceImages(saved.id)).toEqual([scan(1), scan(2)]);
    expect(await getSavedRecipeSourceImages("missing")).toEqual([]);
  });

  it("still reads images embedded by records that predate the migration", async () => {
    mockStore.set("legacy", {
      ...(await saveScanned()),
      id: "legacy",
      sourceImages: [scan(9)]
    });

    expect((await getSavedRecipeById("legacy"))?.sourceImages).toEqual([scan(9)]);
    expect(await getSavedRecipeSourceImages("legacy")).toEqual([scan(9)]);
    expect((await getSavedRecipes()).every((recipe) => !("sourceImages" in recipe))).toBe(true);
  });

  it("keeps images hydrated through edits, cooks and replacements", async () => {
    const saved = await saveScanned();

    const edited = await updateSavedRecipe(saved.id, {
      notes: "  less sugar  ",
      recipe: saved.recipe
    });
    expect(edited?.notes).toBe("less sugar");
    expect(edited?.sourceImages).toEqual([scan(1), scan(2)]);

    const cooked = await incrementSavedRecipeTimesCooked(saved.id);
    expect(cooked?.timesCooked).toBe(1);
    expect(cooked?.sourceImages).toEqual([scan(1), scan(2)]);

    await setRecipeFavorite(saved.id, true);
    const replaced = await forceSaveRecipe({ ...createSaveInput(1) });
    expect(replaced.id).toBe(saved.id);
    expect(replaced.notes).toBe("less sugar");
    expect(replaced.favorite).toBe(true);
    expect(replaced.sourceImages).toEqual([scan(1), scan(2)]);
  });

  it("deletes stored images and any cook session with the recipe", async () => {
    const saved = await saveScanned();
    fakeIdb.seed("cookSessions", [{ recipeId: saved.id, stepIndex: 2 }]);

    await deleteSavedRecipe(saved.id);

    expect(await countSavedRecipes()).toBe(0);
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, saved.id)).toBeUndefined();
    expect(fakeIdb.record("cookSessions", saved.id)).toBeUndefined();
  });

  it("treats an older app's copy of a starter as the personal recipe the limit counts", async () => {
    // Before the redesign, "Duplicate" on a starter kept isStarter under a fresh id.
    const legacyCopy = {
      ...createSaveInput(99),
      createdAt: "2026-06-01T00:00:00.000Z",
      id: "0f0f0f0f-0000-4000-8000-000000000001",
      isStarter: true,
      sync: { status: "local_only" as const },
      sourceHost: "example.com",
      timesCooked: 0,
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [legacyCopy]);

    for (let i = 0; i < LOCAL_LIMIT_FREE - 1; i += 1) {
      expect((await saveRecipe(createSaveInput(i), false)).success).toBe(true);
    }

    // What screens show agrees with what the limit enforces: 15 of 15, and no "starter" copy.
    const listed = await getSavedRecipes();
    expect(listed.filter((recipe) => !recipe.isStarter)).toHaveLength(LOCAL_LIMIT_FREE);
    expect(listed.find((recipe) => recipe.id === legacyCopy.id)).not.toHaveProperty("isStarter");
    expect(await getSavedRecipeById(legacyCopy.id)).not.toHaveProperty("isStarter");
    expect(await countQuotaSavedRecipes()).toBe(LOCAL_LIMIT_FREE);
    expect((await saveRecipe(createSaveInput(LOCAL_LIMIT_FREE), false)).error).toBe(
      "limit_exceeded"
    );

    // The next write stores it that way too.
    await setRecipeFavorite(legacyCopy.id, true);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, legacyCopy.id)).not.toHaveProperty("isStarter");
  });

  it("keeps the seeded starters as starters", async () => {
    await seedStarterRecipesIfNeeded();

    const starters = (await getSavedRecipes()).filter((recipe) => recipe.id.startsWith("starter-"));
    expect(starters.length).toBeGreaterThan(0);
    expect(starters.every((recipe) => recipe.isStarter)).toBe(true);
  });

  it("counts quota from keys without reading whole records", async () => {
    await seedStarterRecipesIfNeeded();
    await saveRecipe(createSaveInput(1), false);
    const db = await getDb();
    const getAll = vi.spyOn(db, "getAll");

    expect(await countQuotaSavedRecipes()).toBe(1);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("names duplicates with a (copy) suffix, drops starter status and copies images", async () => {
    await seedStarterRecipesIfNeeded();
    const [starter] = await getSavedRecipes();

    const copy = await duplicateSavedRecipe(starter!.id, { isPremiumUser: false });
    expect(copy).toMatchObject({
      recipe: { title: `${starter!.recipe.title} (copy)` },
      sync: { status: "local_only" },
      timesCooked: 0
    });
    expect(copy).not.toHaveProperty("isStarter");
    expect(await countQuotaSavedRecipes()).toBe(1);

    const secondCopy = await duplicateSavedRecipe(copy!.id, { isPremiumUser: false });
    expect(secondCopy?.recipe.title).toBe(`${starter!.recipe.title} (copy 2)`);

    const scanned = await saveScanned();
    const scannedCopy = await duplicateSavedRecipe(scanned.id, { isPremiumUser: false });
    expect(await getSavedRecipeSourceImages(scannedCopy!.id)).toEqual([scan(1), scan(2)]);
  });

  it("stops free users from duplicating past the limit but not premium users", async () => {
    for (let i = 0; i < LOCAL_LIMIT_FREE; i += 1) {
      await saveRecipe(createSaveInput(i), false);
    }
    const [first] = await getSavedRecipes();

    await expect(duplicateSavedRecipe(first!.id, { isPremiumUser: false })).rejects.toBeInstanceOf(
      SavedRecipeLimitError
    );
    expect(await countQuotaSavedRecipes()).toBe(LOCAL_LIMIT_FREE);

    await expect(duplicateSavedRecipe(first!.id, { isPremiumUser: true })).resolves.toBeDefined();
    expect(await duplicateSavedRecipe("missing", { isPremiumUser: false })).toBeUndefined();
  });

  it("falls back to the last known signed-in plan when no plan is passed", async () => {
    for (let i = 0; i < LOCAL_LIMIT_FREE; i += 1) {
      await saveRecipe(createSaveInput(i), false);
    }
    const [first] = await getSavedRecipes();

    await expect(duplicateSavedRecipe(first!.id)).rejects.toMatchObject({
      code: "limit_exceeded"
    });

    localStorage.setItem(
      "linkdish:web:auth-user:v1",
      JSON.stringify({
        savedAt: "2026-09-01T00:00:00.000Z",
        source: "clerk",
        user: { billingPlan: "plus", email: "cook@example.com", id: "user_1" }
      })
    );

    await expect(duplicateSavedRecipe(first!.id)).resolves.toBeDefined();
  });

  it("enforces the free limit when copying a family recipe", async () => {
    const sharedRecipe: SharedRecipe = {
      createdAt: "2026-07-01T00:00:00.000Z",
      fetchMode: "http",
      householdId: "house_1",
      id: "shared_1",
      ownerEmail: "cook@example.com",
      ownerUserId: "user_2",
      provenance: ["jsonld"],
      recipe: dummyRecipe,
      strategy: "recipe-schema",
      updatedAt: "2026-07-01T00:00:00.000Z",
      warnings: []
    };

    const copy = await saveSharedRecipeCopy(sharedRecipe, { isPremiumUser: false });
    expect(copy.recipe.title).toBe("Grandma's Cookies (copy)");
    expect(copy).not.toHaveProperty("isStarter");

    for (let i = 0; i < LOCAL_LIMIT_FREE - 1; i += 1) {
      await saveRecipe(createSaveInput(i), false);
    }

    await expect(
      saveSharedRecipeCopy(sharedRecipe, { isPremiumUser: false })
    ).rejects.toBeInstanceOf(SavedRecipeLimitError);
  });

  it("stores personal metadata without touching updatedAt or the sync state", async () => {
    const { recipe: saved } = await saveRecipe(createSaveInput(1), true);
    const id = saved!.id;
    await setRecipeFavorite(id, true);
    await setRecipeTags(id, [" Weeknight ", "weeknight", "", "Vegetarian"]);
    await setRecipeCollections(id, ["col-1", "col-1", "col-2"]);
    await setRecipeRating(id, 4);
    await setRecipePreferredServings(id, 6);
    await markRecipeOpened(id, "2026-09-02T10:00:00.000Z");
    await logRecipeCooked(id, { cookedAt: "2026-09-03T18:00:00.000Z", note: " great " });

    const stored = await getSavedRecipeById(id);
    expect(stored).toMatchObject({
      collectionIds: ["col-1", "col-2"],
      cookLog: [{ cookedAt: "2026-09-03T18:00:00.000Z", note: "great" }],
      favorite: true,
      lastCookedAt: "2026-09-03T18:00:00.000Z",
      lastOpenedAt: "2026-09-02T10:00:00.000Z",
      preferredServings: 6,
      rating: 4,
      sync: { status: "local_only" },
      tags: ["Weeknight", "Vegetarian"],
      timesCooked: 1,
      updatedAt: saved!.updatedAt
    });

    await setRecipeFavorite(id, false);
    await setRecipeRating(id, null);
    await setRecipeTags(id, []);
    const cleared = await getSavedRecipeById(id);
    expect(cleared).not.toHaveProperty("favorite");
    expect(cleared).not.toHaveProperty("rating");
    expect(cleared).not.toHaveProperty("tags");

    await expect(setRecipeRating(id, 7 as never)).rejects.toBeInstanceOf(RangeError);
    expect(await setRecipeFavorite("missing", true)).toBeUndefined();
  });

  it("marks shared recipes dirty when their notes change", async () => {
    const { recipe: saved } = await saveRecipe(createSaveInput(1), true);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      { ...saved, sync: { sharedRecipeId: "s1", status: "synced" } }
    ]);

    const updated = await updateRecipeNotes(saved!.id, " double the garlic ");

    expect(updated?.notes).toBe("double the garlic");
    expect(updated?.sync).toEqual({ sharedRecipeId: "s1", status: "dirty" });
  });

  it("never sends personal metadata to the household", async () => {
    const { recipe: saved } = await saveRecipe(
      { ...createSaveInput(1), sourceImages: [scan(1)] },
      true
    );
    await setRecipeFavorite(saved!.id, true);
    await setRecipeTags(saved!.id, ["Sunday"]);
    await logRecipeCooked(saved!.id);
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "house_1" } });
    apiMocks.createSharedRecipe.mockResolvedValue({
      recipe: { id: "shared_9", updatedAt: "2026-09-04T00:00:00.000Z" }
    });

    const recipe = await getSavedRecipeById(saved!.id);
    const synced = await syncRecipeToHousehold(recipe!);

    const payload = apiMocks.createSharedRecipe.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "fetchMode",
      "notes",
      "provenance",
      "recipe",
      "sourceSavedRecipeId",
      "strategy",
      "warnings"
    ]);
    expect(payload.recipe).toEqual(saved!.recipe);
    expect(synced.sync).toMatchObject({ sharedRecipeId: "shared_9", status: "synced" });
    expect(synced.sourceImages).toEqual([scan(1)]);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, saved!.id)).not.toHaveProperty("sourceImages");
    expect(await getSavedRecipeSourceImages(saved!.id)).toEqual([scan(1)]);
  });

  /** A household sync whose create call waits until `release` is called. */
  const holdHouseholdSync = () => {
    let release: () => void = () => undefined;
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "house_1" } });
    apiMocks.createSharedRecipe.mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({ recipe: { id: "shared_9", updatedAt: "2026-09-04T00:00:00.000Z" } });
      })
    );

    return {
      release: () => release(),
      started: () => vi.waitFor(() => expect(apiMocks.createSharedRecipe).toHaveBeenCalled())
    };
  };

  it("keeps personal metadata written while a household sync is in flight", async () => {
    const { recipe: saved } = await saveRecipe(createSaveInput(1), true);
    const hold = holdHouseholdSync();

    const syncing = syncRecipeToHousehold(saved!);
    await hold.started();
    await setRecipeFavorite(saved!.id, true);
    await setRecipeTags(saved!.id, ["weeknight"]);
    await logRecipeCooked(saved!.id);
    await markRecipeOpened(saved!.id);
    hold.release();
    const synced = await syncing;

    const stored = await getSavedRecipeById(saved!.id);
    expect(stored).toMatchObject({
      favorite: true,
      sync: { sharedRecipeId: "shared_9", status: "synced" },
      tags: ["weeknight"],
      timesCooked: 1
    });
    expect(stored?.lastOpenedAt).toEqual(expect.any(String));
    expect(synced).toMatchObject({ favorite: true, tags: ["weeknight"] });
  });

  it("does not bring back a recipe deleted while a household sync is in flight", async () => {
    const { recipe: saved } = await saveRecipe(createSaveInput(1), true);
    const hold = holdHouseholdSync();

    const syncing = syncRecipeToHousehold(saved!);
    await hold.started();
    await deleteSavedRecipe(saved!.id);
    hold.release();
    await syncing;

    expect(await getSavedRecipes()).toEqual([]);
  });

  it("sends the recipe as stored, not the caller's older copy", async () => {
    const { recipe: saved } = await saveRecipe(createSaveInput(1), true);
    const edited = { ...saved!.recipe, title: "Grandma's Best Cookies" };
    await updateSavedRecipe(saved!.id, { recipe: edited });
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "house_1" } });
    apiMocks.createSharedRecipe.mockResolvedValue({
      recipe: { id: "shared_9", updatedAt: "2026-09-04T00:00:00.000Z" }
    });

    // `saved` predates the edit (e.g. a toast action created before the editor saved).
    const synced = await syncRecipeToHousehold(saved!);

    const payload = apiMocks.createSharedRecipe.mock.calls[0]?.[0] as { recipe: Recipe };
    expect(payload.recipe.title).toBe("Grandma's Best Cookies");
    expect(synced.recipe.title).toBe("Grandma's Best Cookies");
    expect((await getSavedRecipeById(saved!.id))?.recipe.title).toBe("Grandma's Best Cookies");
  });

  it("leaves a recipe edited while its household sync was in flight marked dirty", async () => {
    const { recipe: saved } = await saveRecipe(createSaveInput(1), true);
    const hold = holdHouseholdSync();

    const syncing = syncRecipeToHousehold(saved!);
    await hold.started();
    await updateSavedRecipe(saved!.id, { recipe: { ...saved!.recipe, title: "Newer" } });
    hold.release();
    await syncing;

    const stored = await getSavedRecipeById(saved!.id);
    expect(stored?.recipe.title).toBe("Newer");
    // The household copy has the older content, so the next sync must still send this edit.
    expect(stored?.sync).toMatchObject({ sharedRecipeId: "shared_9", status: "dirty" });
  });

  it("tells subscribers in this tab about writes", async () => {
    const changes: unknown[] = [];
    subscribeDataChanges("savedRecipes", (change, source) => {
      changes.push({ deletedIds: change.deletedIds, source, upserted: change.upserted?.length });
    });

    const { recipe: saved } = await saveRecipe(createSaveInput(1), true);
    await setRecipeFavorite(saved!.id, true);
    await deleteSavedRecipe(saved!.id);

    expect(changes).toEqual([
      { deletedIds: undefined, source: "local", upserted: 1 },
      { deletedIds: undefined, source: "local", upserted: 1 },
      { deletedIds: [saved!.id], source: "local", upserted: undefined }
    ]);
  });

  it("removes a deleted collection from every recipe", async () => {
    const { recipe: a } = await saveRecipe(createSaveInput(1), true);
    const { recipe: b } = await saveRecipe(createSaveInput(2), true);
    await setRecipeCollections(a!.id, ["weeknight", "soups"]);
    await setRecipeCollections(b!.id, ["weeknight"]);

    expect(await removeCollectionFromAllRecipes("weeknight")).toBe(2);

    expect((await getSavedRecipeById(a!.id))?.collectionIds).toEqual(["soups"]);
    expect(await getSavedRecipeById(b!.id)).not.toHaveProperty("collectionIds");
  });

  it("normalizes tags", () => {
    expect(normalizeRecipeTags(["  Quick   dinner ", "quick dinner", "x".repeat(50)])).toEqual([
      "Quick dinner",
      "x".repeat(32)
    ]);
    expect(
      normalizeRecipeTags(Array.from({ length: 30 }, (_, index) => `tag ${index}`))
    ).toHaveLength(20);
  });
});
