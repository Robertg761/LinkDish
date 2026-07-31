import { describe, it, expect, beforeEach, vi } from "vitest";

import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";

import {
  LOCAL_LIMIT_FREE,
  saveRecipe,
  countSavedRecipes,
  countQuotaSavedRecipes,
  generateDeterministicId,
  getDb,
  getSavedRecipeById,
  incrementSavedRecipeTimesCooked,
  seedStarterRecipesIfNeeded
} from "./saved-recipe-store";

import type { Recipe } from "@linkdish/recipe-domain";

const idbMocks = vi.hoisted(() => ({
  openDB: vi.fn(),
  store: new Map<string, unknown>()
}));

const mockStore = idbMocks.store;

vi.mock("idb", () => {
  return {
    openDB: idbMocks.openDB.mockImplementation(
      async (
        _name: string,
        _version: number,
        options?: {
          upgrade?: (
            db: {
              createObjectStore: ReturnType<typeof vi.fn>;
              objectStoreNames: { contains: ReturnType<typeof vi.fn> };
            },
            oldVersion: number,
            newVersion: number,
            transaction: never
          ) => void;
        }
      ) => {
        await Promise.resolve();
        const db = {
          createObjectStore: vi.fn(() => ({
            createIndex: vi.fn()
          })),
          objectStoreNames: {
            contains: vi.fn(() => true)
          },
          transaction: () => ({
            objectStore: () => ({
              getAll: async () => {
                await Promise.resolve();
                return Array.from(mockStore.values());
              },
              get: async (key: string) => {
                await Promise.resolve();
                return mockStore.get(key);
              },
              put: async (val: unknown) => {
                await Promise.resolve();
                const obj = val as { id: string };
                mockStore.set(obj.id, val);
              },
              delete: async (key: string) => {
                await Promise.resolve();
                mockStore.delete(key);
              }
            })
          }),
          get: async (storeName: string, key: string) => {
            await Promise.resolve();
            return mockStore.get(key);
          },
          put: async (storeName: string, val: unknown) => {
            await Promise.resolve();
            const obj = val as { id: string };
            mockStore.set(obj.id, val);
          },
          delete: async (storeName: string, key: string) => {
            await Promise.resolve();
            mockStore.delete(key);
          },
          count: async () => {
            await Promise.resolve();
            return mockStore.size;
          }
        };
        options?.upgrade?.(db, 1, 2, {} as never);
        return db;
      }
    )
  };
});

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
  beforeEach(() => {
    idbMocks.openDB.mockClear();
    mockStore.clear();
    resetLinkDishWebDbForTests();
    localStorage.clear();
  });

  it("opens v1 records under the v2 IndexedDB schema with missing images treated as null", async () => {
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

    expect(idbMocks.openDB).toHaveBeenCalledWith("linkdish-web", 3, expect.any(Object));
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
});
