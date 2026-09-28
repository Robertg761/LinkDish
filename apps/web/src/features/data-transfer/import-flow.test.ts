import { createLinkDishBackup, SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetDataChangeFeedForTests,
  setDataChannelFactoryForTests,
  subscribeDataChanges
} from "../../data/change-feed";
import { createCollection, getCollections } from "../../data/collections-store";
import { getMealPlanEntries } from "../../data/meal-plan-store";
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  MEAL_PLAN_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import {
  generateDeterministicId,
  getSavedRecipeById,
  getSavedRecipes,
  LOCAL_LIMIT_FREE,
  putSavedRecipe
} from "../library/saved-recipe-store";

import { WEB_BACKUP_EXTRAS_KEY } from "./backup-format";
import { prepareImport, previewImport, runImport } from "./data-transfer";
import { DataTransferError } from "./errors";
import {
  buildPaprikaExport,
  fileFromBytes,
  jsonBytes,
  paprikaRecipe
} from "./testing/zip-fixtures";

import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
vi.mock("../../api/client", () => ({ apiClient: {} }));

const analytics = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));
vi.mock("../../analytics/client", () => ({ trackWebEvent: analytics.trackWebEvent }));

const skillet = SAMPLE_RECIPES[0].recipe as Recipe;
const starterId = SAMPLE_RECIPES[1].id;
const starterRecipe = SAMPLE_RECIPES[1].recipe as Recipe;
const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==";

const record = (id: string, overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => ({
  id,
  recipe: { ...skillet, title: `Recipe ${id}`, sourceUrl: `https://example.com/${id}` },
  sourceUrl: `https://example.com/${id}`,
  sourceHost: "example.com",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  timesCooked: 0,
  sync: { status: "local_only" },
  ...overrides
});

const starterRecord = (overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe =>
  record(starterId, {
    recipe: starterRecipe,
    sourceUrl: starterRecipe.sourceUrl,
    sourceHost: new URL(starterRecipe.sourceUrl).hostname,
    isStarter: true,
    ...overrides
  });

const soups = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    paprikaRecipe({
      uid: `soup-${index}`,
      name: `Soup number ${index + 1}`,
      source_url: `https://soups.example.com/soup-${index + 1}`
    })
  );

const importFile = async (
  name: string,
  bytes: Uint8Array,
  options: { duplicateMode?: "skip" | "keep"; isPremium?: boolean } = {}
) => {
  const prepared = await prepareImport(fileFromBytes(bytes, name));
  const settings = {
    duplicateMode: options.duplicateMode ?? "skip",
    isPremium: options.isPremium ?? false
  };
  const preview = previewImport(prepared, settings);
  const result = await runImport(prepared, settings);
  return { prepared, preview, result };
};

describe("importing into the cookbook", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    analytics.trackWebEvent.mockReset();
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes new recipes in a single transaction and skips duplicates by default", async () => {
    await importFile("first.paprikarecipes", await buildPaprikaExport([paprikaRecipe()]));
    const db = await getLinkDishWebDb();
    const transaction = vi.spyOn(db, "transaction");
    const changes: string[] = [];
    subscribeDataChanges("savedRecipes", (change) => {
      changes.push(`${change.upserted?.length ?? 0} upserted`);
    });
    analytics.trackWebEvent.mockReset();

    const { result } = await importFile(
      "export.paprikarecipes",
      await buildPaprikaExport([paprikaRecipe(), ...soups(2)])
    );

    expect(result.plan.counts).toMatchObject({
      found: 3,
      imported: 2,
      duplicates: 1,
      skippedDuplicates: 1,
      overLimit: 0
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(
      [
        SAVED_RECIPES_STORE_NAME,
        RECIPE_SOURCE_IMAGES_STORE_NAME,
        COLLECTIONS_STORE_NAME,
        MEAL_PLAN_STORE_NAME
      ],
      "readwrite"
    );
    expect(changes).toEqual(["2 upserted"]);
    expect((await getSavedRecipes()).map((recipe) => recipe.recipe.title).sort()).toEqual([
      "Soup number 1",
      "Soup number 2",
      "Weeknight Tomato Soup"
    ]);
    expect(analytics.trackWebEvent).toHaveBeenCalledWith({
      eventName: "library_imported",
      routeOrScreen: "/settings",
      properties: {
        source: "paprika",
        recipe_count: 2,
        skipped_duplicates: 1,
        over_limit: 0,
        duplicate_mode: "skip"
      }
    });
  });

  it("stores imported recipes with the deterministic id and their personal details", async () => {
    await importFile("export.paprikarecipes", await buildPaprikaExport([paprikaRecipe()]));
    const id = await generateDeterministicId(
      "https://www.seriouseats.com/weeknight-tomato-soup",
      "Weeknight Tomato Soup"
    );
    const stored = await getSavedRecipeById(id);

    expect(stored).toMatchObject({
      id,
      sourceHost: "seriouseats.com",
      favorite: true,
      rating: 4,
      tags: ["Soup", "Weeknight"],
      notes: "Add a pinch of sugar if the tomatoes are sharp.",
      createdAt: "2024-02-03T18:22:11.000Z",
      sync: { status: "local_only" },
      extraction: { strategy: "recipe-schema" }
    });
    expect(stored?.isStarter).toBeUndefined();
  });

  it("spots the same recipe behind tracking parameters and www", async () => {
    await putSavedRecipe(
      record("existing", {
        recipe: { ...skillet, title: "Weeknight Tomato Soup" },
        sourceUrl: "https://seriouseats.com/weeknight-tomato-soup/?utm_source=newsletter#comments"
      })
    );

    const { result } = await importFile(
      "export.paprikarecipes",
      await buildPaprikaExport([paprikaRecipe()])
    );

    expect(result.plan.counts).toMatchObject({ imported: 0, skippedDuplicates: 1 });
  });

  it("keeps both copies when asked, under a fresh id", async () => {
    await importFile("first.paprikarecipes", await buildPaprikaExport([paprikaRecipe()]));

    const { result } = await importFile(
      "again.paprikarecipes",
      await buildPaprikaExport([paprikaRecipe()]),
      { duplicateMode: "keep" }
    );

    expect(result.plan.counts).toMatchObject({
      imported: 1,
      keptDuplicates: 1,
      skippedDuplicates: 0
    });
    const titles = (await getSavedRecipes()).map((recipe) => recipe.recipe.title);
    expect(titles).toEqual(["Weeknight Tomato Soup", "Weeknight Tomato Soup"]);
    expect(result.recipeIds[0]).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("treats a recipe repeated inside the file as a duplicate", async () => {
    const { result } = await importFile(
      "export.paprikarecipes",
      await buildPaprikaExport([paprikaRecipe(), paprikaRecipe({ uid: "copy" })])
    );

    expect(result.plan.counts).toMatchObject({ found: 2, imported: 1, skippedDuplicates: 1 });
  });

  it("imports only what fits in a free cookbook and says how many were left out", async () => {
    for (let index = 0; index < LOCAL_LIMIT_FREE - 2; index += 1) {
      await putSavedRecipe(record(`mine-${index}`));
    }
    // Starter recipes never count toward the limit.
    await putSavedRecipe(starterRecord());

    const { preview, result } = await importFile(
      "export.paprikarecipes",
      await buildPaprikaExport(soups(5))
    );

    expect(preview.remainingFreeSlots).toBe(2);
    expect(preview.counts).toMatchObject({ imported: 2, overLimit: 3 });
    expect(result.plan.limitReached).toBe(true);
    expect(result.plan.counts).toMatchObject({ imported: 2, overLimit: 3 });
    expect(result.plan.recipes.map((recipe) => recipe.recipe.title)).toEqual([
      "Soup number 1",
      "Soup number 2"
    ]);
    expect(await getSavedRecipes()).toHaveLength(LOCAL_LIMIT_FREE + 1);
  });

  it("imports everything for Plus and Family cooks", async () => {
    for (let index = 0; index < LOCAL_LIMIT_FREE; index += 1) {
      await putSavedRecipe(record(`mine-${index}`));
    }

    const { result } = await importFile(
      "export.paprikarecipes",
      await buildPaprikaExport(soups(4)),
      { isPremium: true }
    );

    expect(result.plan.counts).toMatchObject({ imported: 4, overLimit: 0 });
    expect(await getSavedRecipes()).toHaveLength(LOCAL_LIMIT_FREE + 4);
  });

  it("re-checks the limit inside the transaction", async () => {
    const prepared = await prepareImport(
      fileFromBytes(await buildPaprikaExport(soups(3)), "export.paprikarecipes")
    );
    // Another tab fills the cookbook between the preview and the import.
    for (let index = 0; index < LOCAL_LIMIT_FREE - 1; index += 1) {
      await putSavedRecipe(record(`other-tab-${index}`));
    }

    const result = await runImport(prepared, { duplicateMode: "skip", isPremium: false });

    expect(result.plan.counts).toMatchObject({ imported: 1, overLimit: 2 });
  });

  it("restores a LinkDish backup: metadata, scans, collections, meal plan and starters", async () => {
    const skilletId = await generateDeterministicId(skillet.sourceUrl, skillet.title);
    await putSavedRecipe(starterRecord());
    await putSavedRecipe(record("already-here"));
    await createCollection({ name: "weeknights" });

    const backup = {
      ...createLinkDishBackup({
        exportedAt: "2026-09-27T10:00:00.000Z",
        recipes: [
          {
            id: skilletId,
            recipe: skillet,
            meta: {
              favorite: true,
              tags: ["weeknight", "rice"],
              rating: 5,
              notes: "Double the sauce.",
              timesCooked: 3,
              cookLog: [{ cookedAt: "2026-09-20T18:00:00.000Z" }],
              createdAt: "2026-09-01T12:00:00.000Z",
              updatedAt: "2026-09-20T18:30:00.000Z",
              sourceUrl: skillet.sourceUrl
            }
          },
          {
            id: starterId,
            recipe: starterRecipe,
            meta: {
              favorite: true,
              notes: "Use raspberries.",
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
              sourceUrl: starterRecipe.sourceUrl
            }
          },
          {
            id: "already-here",
            recipe: record("already-here").recipe,
            meta: {
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
              sourceUrl: "https://example.com/already-here"
            }
          },
          {
            id: "starter-made-up",
            recipe: { ...skillet, title: "Sneaky", sourceUrl: "https://example.com/sneaky" },
            meta: {
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
              sourceUrl: "https://example.com/sneaky"
            }
          }
        ],
        collections: [
          { id: "backup-weeknights", name: "Weeknights", recipeIds: [skilletId, "already-here"] },
          { id: "backup-baking", name: "Baking", recipeIds: [starterId] },
          { id: "backup-unused", name: "Nothing here", recipeIds: ["missing"] }
        ],
        mealPlan: [
          { id: "m1", date: "2026-09-28", slot: "dinner", recipeId: skilletId, servings: 4 },
          { id: "m2", date: "2026-09-29", recipeId: "gone" },
          { id: "m3", date: "2026-09-30", slot: "lunch", title: "Leftovers" }
        ]
      }),
      [WEB_BACKUP_EXTRAS_KEY]: {
        version: 1,
        recipes: { [skilletId]: { preferredServings: 6 } },
        collections: { "backup-baking": { emoji: "🧁", sortOrder: 1 } },
        mealPlan: {},
        sourceImages: { [skilletId]: [{ dataUrl: TINY_JPEG, mimeType: "image/jpeg" }] }
      }
    };

    const { result } = await importFile("linkdish-backup.json", jsonBytes(backup));

    expect(result.plan.counts).toMatchObject({
      found: 4,
      imported: 2,
      restoredStarters: 1,
      skippedDuplicates: 1,
      collectionsCreated: 1,
      collectionsMatched: 1,
      mealPlanAdded: 3
    });

    const collections = await getCollections();
    const weeknights = collections.find((collection) => collection.name === "weeknights");
    const baking = collections.find((collection) => collection.name === "Baking");
    expect(collections.map((collection) => collection.name).sort()).toEqual([
      "Baking",
      "weeknights"
    ]);
    expect(baking).toMatchObject({ id: "backup-baking", emoji: "🧁" });

    const restored = await getSavedRecipeById(skilletId);
    expect(restored).toMatchObject({
      favorite: true,
      tags: ["weeknight", "rice"],
      rating: 5,
      notes: "Double the sauce.",
      timesCooked: 3,
      cookLog: [{ cookedAt: "2026-09-20T18:00:00.000Z" }],
      lastCookedAt: "2026-09-20T18:00:00.000Z",
      preferredServings: 6,
      collectionIds: [weeknights?.id],
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-20T18:30:00.000Z",
      sourceImageCount: 1
    });
    expect(restored?.sourceImages).toEqual([{ dataUrl: TINY_JPEG, mimeType: "image/jpeg" }]);

    // The untouched starter was replaced by the personalized one (still a starter).
    expect(await getSavedRecipeById(starterId)).toMatchObject({
      isStarter: true,
      favorite: true,
      notes: "Use raspberries.",
      collectionIds: ["backup-baking"]
    });
    // A made-up "starter-" id can't dodge the free limit.
    const sneaky = (await getSavedRecipes()).find((recipe) => recipe.recipe.title === "Sneaky");
    expect(sneaky?.id.startsWith("starter-")).toBe(false);
    expect(sneaky?.isStarter).toBeUndefined();
    // The duplicate kept its local copy but joined the restored collection.
    expect(await getSavedRecipeById("already-here")).toMatchObject({
      collectionIds: [weeknights?.id]
    });

    const plan = await getMealPlanEntries();
    expect(plan).toEqual([
      expect.objectContaining({
        id: "m1",
        recipeId: skilletId,
        slot: "dinner",
        servings: 4,
        title: skillet.title
      }),
      expect.objectContaining({ id: "m2", slot: "dinner", title: "Planned meal" }),
      expect.objectContaining({ id: "m3", slot: "lunch", title: "Leftovers" })
    ]);
    expect(plan[1]).not.toHaveProperty("recipeId");

    // Restoring the same backup again changes nothing.
    const again = await importFile("linkdish-backup.json", jsonBytes(backup));
    expect(again.result.plan.counts).toMatchObject({
      imported: 0,
      restoredStarters: 0,
      skippedDuplicates: 4,
      collectionsCreated: 0,
      mealPlanAdded: 0,
      mealPlanSkipped: 3
    });
    expect(again.preview.membershipAdditions).toEqual([]);
    expect(again.result.plan.recipes).toEqual([]);
  });

  it("explains a full device instead of failing with a raw error", async () => {
    fakeIdb.failNextPut(
      SAVED_RECIPES_STORE_NAME,
      new DOMException("The quota has been exceeded.", "QuotaExceededError")
    );
    const prepared = await prepareImport(
      fileFromBytes(await buildPaprikaExport(soups(1)), "export.paprikarecipes")
    );

    const failure = runImport(prepared, { duplicateMode: "skip", isPremium: true });

    await expect(failure).rejects.toBeInstanceOf(DataTransferError);
    await expect(failure).rejects.toMatchObject({ code: "storage_full" });
    expect(analytics.trackWebEvent).not.toHaveBeenCalled();
  });

  it("never writes when the file can't be read", async () => {
    await expect(
      prepareImport(fileFromBytes(jsonBytes({ nope: true }), "random.json"))
    ).rejects.toMatchObject({ code: "unsupported_file" });
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toEqual([]);
  });
});
