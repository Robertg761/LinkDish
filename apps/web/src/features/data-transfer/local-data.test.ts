import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  MEAL_PLAN_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { saveRecipe } from "../library/saved-recipe-store";

import { measureSourceImages, readLocalDataCounts } from "./local-data";

import type { Recipe } from "@linkdish/recipe-domain";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
vi.mock("../../api/client", () => ({ apiClient: {} }));

const base = SAMPLE_RECIPES[0].recipe as Recipe;

const scan = (size: number) => ({
  dataUrl: `data:image/jpeg;base64,${"A".repeat(size)}`,
  mimeType: "image/jpeg" as const
});

const saveScanned = async (index: number, scans: Array<ReturnType<typeof scan>>) => {
  const sourceUrl = `https://linkdish.app/image-imports/web-${index}`;
  const result = await saveRecipe(
    {
      extraction: {
        fetchMode: "http",
        provenance: ["jsonld"],
        strategy: "recipe-schema",
        warnings: []
      },
      recipe: { ...base, sourceUrl, title: `Scan ${index}` },
      sourceImages: scans,
      sourceUrl
    },
    true
  );
  return result.recipe!;
};

describe("measureSourceImages", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    await getLinkDishWebDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sums the scans' size without loading every stored scan", async () => {
    const first = await saveScanned(1, [scan(100), scan(200)]);
    const second = await saveScanned(2, [scan(50)]);
    await saveScanned(3, [scan(999)]);
    const db = await getLinkDishWebDb();
    const getAll = vi.spyOn(db, "getAll");
    const get = vi.spyOn(db, "get");

    const stats = await measureSourceImages(new Set([first.id, second.id]));

    const length = (size: number) => scan(size).dataUrl.length;
    expect(stats).toEqual({ bytes: length(100) + length(200) + length(50), images: 3, recipes: 2 });
    expect(getAll).not.toHaveBeenCalledWith(RECIPE_SOURCE_IMAGES_STORE_NAME);
    expect(get).not.toHaveBeenCalledWith(RECIPE_SOURCE_IMAGES_STORE_NAME, expect.anything());
  });

  it("still measures scans saved before their size was recorded", async () => {
    const saved = await saveScanned(1, [scan(120)]);
    const stored = fakeIdb.record<Record<string, unknown>>(SAVED_RECIPES_STORE_NAME, saved.id);
    delete stored?.sourceImageBytes;
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [stored]);

    expect(await measureSourceImages(new Set([saved.id]))).toEqual({
      bytes: scan(120).dataUrl.length,
      images: 1,
      recipes: 1
    });
  });

  it("measures every recipe's scans when no ids are given", async () => {
    await saveScanned(1, [scan(10)]);
    await saveScanned(2, [scan(20), scan(30)]);

    expect(await measureSourceImages()).toMatchObject({ images: 3, recipes: 2 });
  });
});

describe("readLocalDataCounts", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    await getLinkDishWebDb();
  });

  it("counts personal recipes, starters, collections and planned meals at one moment", async () => {
    await saveScanned(1, [scan(10)]);
    await saveScanned(2, []);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [{ id: `${SAMPLE_RECIPES[0].id}` }]);
    fakeIdb.seed(COLLECTIONS_STORE_NAME, [{ id: "c1" }, { id: "c2" }]);
    fakeIdb.seed(MEAL_PLAN_STORE_NAME, [{ id: "m1" }]);
    const db = await getLinkDishWebDb();
    const transaction = vi.spyOn(db, "transaction");

    expect(await readLocalDataCounts()).toEqual({
      collections: 2,
      mealPlanEntries: 1,
      recipes: 2,
      starters: 1
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(
      [SAVED_RECIPES_STORE_NAME, COLLECTIONS_STORE_NAME, MEAL_PLAN_STORE_NAME],
      "readonly"
    );
  });
});
