import { createLinkDishBackup, SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetDataChangeFeedForTests,
  setDataChannelFactoryForTests,
  subscribeDataChanges
} from "../../data/change-feed";
import { createCollection, getCollections } from "../../data/collections-store";
import { addMealPlanEntry, getMealPlanEntries } from "../../data/meal-plan-store";
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
  deleteSavedRecipe,
  duplicateSavedRecipe,
  generateDeterministicId,
  getSavedRecipeById,
  getSavedRecipes,
  LOCAL_LIMIT_FREE,
  putSavedRecipe,
  seedStarterRecipesIfNeeded,
  setRecipeFavorite
} from "../library/saved-recipe-store";

import { buildBackup } from "./backup-export";
import { WEB_BACKUP_EXTRAS_KEY } from "./backup-format";
import { prepareImport, previewImport, runImport } from "./data-transfer";
import { DataTransferError } from "./errors";
import { loadExportSnapshot } from "./export-snapshot";
import { MAX_IMPORT_FILE_BYTES } from "./import-formats";
import {
  buildPaprikaExport,
  fileFromBytes,
  fileOfSize,
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
    // The preview reads the cookbook in one readonly transaction; the import writes in one more.
    expect(transaction.mock.calls).toEqual([
      [[SAVED_RECIPES_STORE_NAME, COLLECTIONS_STORE_NAME, MEAL_PLAN_STORE_NAME], "readonly"],
      [
        [
          SAVED_RECIPES_STORE_NAME,
          RECIPE_SOURCE_IMAGES_STORE_NAME,
          COLLECTIONS_STORE_NAME,
          MEAL_PLAN_STORE_NAME
        ],
        "readwrite"
      ]
    ]);
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

  describe("a starter that changes between the preview and the import", () => {
    const starterBackup = () =>
      jsonBytes(
        createLinkDishBackup({
          exportedAt: "2026-09-27T10:00:00.000Z",
          recipes: [
            {
              id: starterId,
              recipe: starterRecipe,
              meta: {
                notes: "Use raspberries.",
                createdAt: "2026-09-01T00:00:00.000Z",
                updatedAt: "2026-09-01T00:00:00.000Z",
                sourceUrl: starterRecipe.sourceUrl
              }
            }
          ]
        })
      );
    const settings = { duplicateMode: "skip", isPremium: false } as const;

    it("keeps a starter made personal after the preview", async () => {
      await putSavedRecipe(starterRecord());
      const prepared = await prepareImport(fileFromBytes(starterBackup(), "linkdish-backup.json"));
      expect(previewImport(prepared, settings).counts).toMatchObject({ restoredStarters: 1 });

      // Another tab favorites the starter before the import is confirmed.
      await setRecipeFavorite(starterId, true);
      const result = await runImport(prepared, settings);

      expect(result.plan.counts).toMatchObject({ restoredStarters: 0, skippedDuplicates: 1 });
      expect(result.recipeIds).toEqual([]);
      const starter = await getSavedRecipeById(starterId);
      expect(starter).toMatchObject({ favorite: true, isStarter: true });
      expect(starter?.notes).toBeUndefined();
    });

    it("restores a starter deleted after the preview as a starter", async () => {
      await putSavedRecipe(starterRecord());
      const prepared = await prepareImport(fileFromBytes(starterBackup(), "linkdish-backup.json"));
      await deleteSavedRecipe(starterId);

      const result = await runImport(prepared, settings);

      expect(result.plan.counts).toMatchObject({ imported: 0, restoredStarters: 1 });
      expect(await getSavedRecipeById(starterId)).toMatchObject({
        isStarter: true,
        notes: "Use raspberries."
      });
    });
  });

  describe("restoring a LinkDish backup made from this app", () => {
    /** Exports this device's cookbook, then starts over on an empty device. */
    const exportAndWipe = async () => {
      const { backup } = buildBackup(await loadExportSnapshot(), {
        exportedAt: "2026-09-28T00:00:00.000Z",
        includeImages: false
      });
      fakeIdb.reset();
      resetLinkDishWebDbForTests();
      localStorage.clear();
      return jsonBytes(backup);
    };

    const summary = async () =>
      (await getSavedRecipes())
        .map((recipe) => `${recipe.recipe.title} · ${recipe.notes ?? ""}`)
        .sort();

    it("brings back every recipe, even look-alikes that share a link or a title", async () => {
      const at = (id: string, url: string, title: string, extra: Partial<WebSavedRecipe> = {}) =>
        record(id, {
          recipe: { ...skillet, sourceUrl: url, title },
          sourceHost: new URL(url).hostname.replace(/^www\./u, ""),
          sourceUrl: url,
          ...extra
        });

      await putSavedRecipe(at("soup", "https://example.com/soup", "Soup", { notes: "first" }));
      // A copy made with "Duplicate" keeps the link; an older app's copy kept the title too.
      const copy = await duplicateSavedRecipe("soup", { isPremiumUser: true });
      await putSavedRecipe(
        at("soup-again", "https://example.com/soup", "Soup", { notes: "second pot" })
      );
      // Pasted-text imports all live on linkdish.app.
      await putSavedRecipe(
        at("text-1", "https://linkdish.app/text-imports/web-1-aaaa", "Pancakes", {
          notes: "classic"
        })
      );
      await putSavedRecipe(
        at("text-2", "https://linkdish.app/text-imports/web-2-bbbb", "Pancakes", {
          notes: "vegan version"
        })
      );
      // Different pages on one site that share a title.
      await putSavedRecipe(
        at("bread-1", "https://www.allrecipes.com/recipe/1/banana-bread/", "Banana Bread")
      );
      await putSavedRecipe(
        at("bread-2", "https://www.allrecipes.com/recipe/2/best-banana-bread/", "Banana Bread")
      );
      const before = await summary();
      expect(before).toHaveLength(7);
      expect(copy).toBeDefined();

      const { preview, result } = await importFile("linkdish-backup.json", await exportAndWipe(), {
        isPremium: true
      });

      expect(preview.counts).toMatchObject({ duplicates: 0, found: 7 });
      expect(result.plan.counts).toMatchObject({ imported: 7, skippedDuplicates: 0 });
      expect(await summary()).toEqual(before);
      expect(await getSavedRecipeById(copy!.id)).toMatchObject({
        recipe: { title: "Soup (copy)" }
      });
    });

    it("keeps a personal copy of a starter when the new device has the starters", async () => {
      await seedStarterRecipesIfNeeded();
      const copy = await duplicateSavedRecipe(starterId, { isPremiumUser: true });
      await setRecipeFavorite(copy!.id, true);
      const bytes = await exportAndWipe();
      await seedStarterRecipesIfNeeded();

      const { result } = await importFile("linkdish-backup.json", bytes, { isPremium: true });

      expect(result.plan.counts).toMatchObject({ imported: 1, skippedDuplicates: 0 });
      expect(await getSavedRecipeById(copy!.id)).toMatchObject({ favorite: true });
    });

    it("still treats a recipe that is already here (same id) as a duplicate", async () => {
      await putSavedRecipe(record("kept", { notes: "on both devices" }));
      const bytes = await exportAndWipe();
      await putSavedRecipe(record("kept", { notes: "edited here" }));

      const { result } = await importFile("linkdish-backup.json", bytes, { isPremium: true });

      expect(result.plan.counts).toMatchObject({ imported: 0, skippedDuplicates: 1 });
      expect(await getSavedRecipeById("kept")).toMatchObject({ notes: "edited here" });
    });
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

  it("restores nothing when the device fills up part-way through a restore", async () => {
    const weeknights = await createCollection({ name: "Weeknights" });
    await putSavedRecipe(record("mine", { collectionIds: [weeknights.id] }));
    await addMealPlanEntry({ date: "2026-09-29", recipeId: "mine", slot: "dinner", title: "Mine" });
    const { backup } = buildBackup(await loadExportSnapshot(), {
      exportedAt: "2026-09-28T00:00:00.000Z",
      includeImages: false
    });
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    const prepared = await prepareImport(fileFromBytes(jsonBytes(backup), "linkdish-backup.json"));
    const changes: unknown[] = [];
    for (const topic of ["savedRecipes", "collections", "mealPlan"] as const) {
      subscribeDataChanges(topic, (change) => changes.push(change));
    }
    // The meal plan is written last, after the collections and recipes.
    fakeIdb.failNextPut(
      MEAL_PLAN_STORE_NAME,
      new DOMException("The quota has been exceeded.", "QuotaExceededError")
    );

    await expect(
      runImport(prepared, { duplicateMode: "skip", isPremium: true })
    ).rejects.toMatchObject({ code: "storage_full" });

    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toEqual([]);
    expect(fakeIdb.records(COLLECTIONS_STORE_NAME)).toEqual([]);
    expect(fakeIdb.records(MEAL_PLAN_STORE_NAME)).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("turns away a file over the size limit before reading any of it", async () => {
    const arrayBuffer = vi.fn(() => Promise.reject(new Error("The whole file was read.")));

    await expect(
      prepareImport(fileOfSize("export.paprikarecipes", MAX_IMPORT_FILE_BYTES + 1, arrayBuffer))
    ).rejects.toMatchObject({
      code: "file_too_large",
      message: expect.stringMatching(/too big to open/u) as string
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toEqual([]);
  });

  it("never writes when the file can't be read", async () => {
    await expect(
      prepareImport(fileFromBytes(jsonBytes({ nope: true }), "random.json"))
    ).rejects.toMatchObject({ code: "unsupported_file" });
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toEqual([]);
  });
});
