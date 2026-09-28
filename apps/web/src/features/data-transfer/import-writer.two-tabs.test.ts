import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { createCollection } from "../../data/collections-store";
import {
  getLinkDishWebDb,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { isolateFakeIdbTransactions } from "../../storage/testing/fake-idb-isolation";
import {
  deleteSavedRecipe,
  putSavedRecipe,
  setRecipeCollectionMembership
} from "../library/saved-recipe-store";

import { buildBackup } from "./backup-export";
import { prepareImport, previewImport, runImport } from "./data-transfer";
import { loadExportSnapshot } from "./export-snapshot";
import {
  buildPaprikaExport,
  fileFromBytes,
  jsonBytes,
  paprikaRecipe
} from "./testing/zip-fixtures";

import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock(
  "idb",
  async () => (await import("../../storage/testing/fake-idb-isolation")).isolatingFakeIdbModule
);
vi.mock("../../api/client", () => ({ apiClient: {} }));
vi.mock("../../analytics/client", () => ({ trackWebEvent: vi.fn() }));

/** Another tab on the same database: fresh copies of the connection, change feed and stores. */
const openOtherTab = async () => {
  vi.resetModules();
  const feed = await import("../../data/change-feed");
  const store = await import("../library/saved-recipe-store");
  await (await import("../../storage/linkdish-db")).getLinkDishWebDb();
  feed.setDataChannelFactoryForTests(() => null);
  return { store };
};

const settings = { duplicateMode: "skip", isPremium: false } as const;

const saved = (
  id: string,
  sourceUrl = `https://example.com/${id}`,
  overrides: Partial<WebSavedRecipe> = {}
): WebSavedRecipe => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
  id,
  recipe: { ...(SAMPLE_RECIPES[0].recipe as Recipe), sourceUrl, title: `Recipe ${id}` },
  sourceHost: new URL(sourceUrl).hostname,
  sourceUrl,
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides
});

const stored = (id: string) => fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id);

/** A LinkDish backup of this device's cookbook, as the file a restore reads. */
const backupFile = async (): Promise<File> => {
  const { backup } = buildBackup(await loadExportSnapshot(), {
    exportedAt: "2026-09-28T00:00:00.000Z",
    includeImages: false
  });
  return fileFromBytes(jsonBytes(backup), "linkdish-backup.json");
};

describe("imports written while another tab changes the cookbook", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    isolateFakeIdbTransactions();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
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

  it("puts a skipped duplicate back in a collection another tab took it out of", async () => {
    const weeknights = await createCollection({ name: "Weeknights" });
    await putSavedRecipe(saved("mine", undefined, { collectionIds: [weeknights.id] }));
    const prepared = await prepareImport(await backupFile());
    expect(previewImport(prepared, settings)).toMatchObject({
      counts: { skippedDuplicates: 1 },
      membershipAdditions: []
    });

    // Before Import is pressed, another tab takes the recipe out of the collection.
    const other = await openOtherTab();
    await other.store.setRecipeCollectionMembership("mine", weeknights.id, false);
    expect(stored("mine")?.collectionIds).toBeUndefined();

    const result = await runImport(prepared, settings);

    expect(result.plan.membershipAdditions).toEqual([
      { recipeId: "mine", collectionIds: [weeknights.id] }
    ]);
    expect(stored("mine")?.collectionIds).toEqual([weeknights.id]);
  });

  it("plans no change for a membership another tab already restored", async () => {
    const weeknights = await createCollection({ name: "Weeknights" });
    await putSavedRecipe(saved("mine", undefined, { collectionIds: [weeknights.id] }));
    const file = await backupFile();
    await setRecipeCollectionMembership("mine", weeknights.id, false);
    const prepared = await prepareImport(file);
    expect(previewImport(prepared, settings).membershipAdditions).toEqual([
      { recipeId: "mine", collectionIds: [weeknights.id] }
    ]);

    const other = await openOtherTab();
    await other.store.setRecipeCollectionMembership("mine", weeknights.id, true);

    const result = await runImport(prepared, settings);

    expect(result.plan.membershipAdditions).toEqual([]);
    expect(stored("mine")?.collectionIds).toEqual([weeknights.id]);
  });

  it("skips a recipe another tab saved after the preview, even under a tracking link", async () => {
    const prepared = await prepareImport(
      fileFromBytes(await buildPaprikaExport([paprikaRecipe()]), "export.paprikarecipes")
    );
    expect(previewImport(prepared, settings).counts).toMatchObject({ duplicates: 0, imported: 1 });

    // Before Import is pressed, another tab saves the same recipe from a newsletter link.
    const other = await openOtherTab();
    const link = "https://seriouseats.com/weeknight-tomato-soup?utm_source=newsletter";
    await other.store.putSavedRecipe(
      saved("from-other-tab", link, {
        recipe: { ...(SAMPLE_RECIPES[0].recipe as Recipe), sourceUrl: link, title: "Tomato Soup" }
      })
    );

    const result = await runImport(prepared, settings);

    expect(result.plan.counts).toMatchObject({ duplicates: 1, imported: 0, skippedDuplicates: 1 });
    expect(result.recipeIds).toEqual([]);
    expect(fakeIdb.records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME).map((r) => r.id)).toEqual([
      "from-other-tab"
    ]);
  });

  it("still restores a backup's recipe when another tab saves a look-alike after the preview", async () => {
    await putSavedRecipe(saved("soup", "https://example.com/soup", { notes: "first pot" }));
    const file = await backupFile();
    await deleteSavedRecipe("soup");
    const prepared = await prepareImport(file);

    // A LinkDish backup names its recipes by id: a copy with the same link is another recipe.
    const other = await openOtherTab();
    await other.store.putSavedRecipe(
      saved("soup-again", "https://example.com/soup", {
        notes: "second pot",
        recipe: { ...saved("soup").recipe }
      })
    );

    const result = await runImport(prepared, settings);

    expect(result.plan.counts).toMatchObject({ duplicates: 0, imported: 1 });
    expect(stored("soup")).toMatchObject({ notes: "first pot" });
    expect(stored("soup-again")).toMatchObject({ notes: "second pot" });
  });
});
