import { SAMPLE_RECIPES, validateBackup } from "@linkdish/recipe-domain";
import { describe, expect, it } from "vitest";

import {
  BACKUP_EXTRAS_KEY,
  backupFileName,
  buildMobileBackup,
  describeRestore,
  planBackupRestore,
  readBackupExtras,
  type RestoreContext
} from "./backup";

import type { MealPlanEntry } from "../meal-plan/store";
import type { MobileCollection } from "../saved-recipes/collections";
import type { SavedRecipeRecord } from "../saved-recipes/store";

const sample = SAMPLE_RECIPES[0];

const record = (id: string, overrides: Partial<SavedRecipeRecord> = {}): SavedRecipeRecord => ({
  fetchMode: "browser",
  id,
  provenance: ["visible-text"],
  recipe: { ...sample.recipe, sourceUrl: `https://example.com/${id}`, title: `Recipe ${id}` },
  savedAt: "2026-10-01T12:00:00.000Z",
  strategy: "llm-fallback",
  timesCooked: 0,
  updatedAt: "2026-10-02T12:00:00.000Z",
  warnings: ["Steps were rebuilt from the page."],
  ...overrides
});

const collection = (id: string, name: string, sortOrder: number): MobileCollection => ({
  createdAt: "2026-10-03T12:00:00.000Z",
  emoji: "🍝",
  id,
  name,
  sortOrder,
  updatedAt: "2026-10-03T12:00:00.000Z"
});

const meal: MealPlanEntry = {
  createdAt: "2026-10-20T08:00:00.000Z",
  date: "2026-10-27",
  id: "plan-1",
  recipeId: "saved-pasta",
  servings: 2,
  slot: "dinner",
  title: "Recipe saved-pasta",
  updatedAt: "2026-10-21T08:00:00.000Z"
};

const pasta = record("saved-pasta", {
  favorite: true,
  libraryExtras: {
    collectionIds: ["collection-weeknights"],
    cookLog: [{ cookedAt: "2026-10-10T19:00:00.000Z", note: "Less salt" }],
    lastCookedAt: "2026-10-10T19:00:00.000Z",
    preferredServings: 3,
    rating: 5,
    tags: ["Weeknight", "Pasta"]
  },
  notes: "Use bucatini.",
  timesCooked: 1
});
const plainStarter = record(sample.id, { isStarter: true, updatedAt: undefined });
const weeknights = collection("collection-weeknights", "Weeknights", 0);
const holidays = { ...collection("collection-holidays", "Holidays", 1), emoji: undefined };

const exported = () =>
  buildMobileBackup({
    collections: [weeknights, holidays],
    exportedAt: "2026-10-26T12:00:00.000Z",
    mealPlan: [meal],
    records: [pasta, plainStarter, record("saved-soup")]
  });

const emptyDevice = (overrides: Partial<RestoreContext> = {}): RestoreContext => {
  let next = 0;
  return {
    collections: [],
    createId: (kind) => `${kind}-new-${(next += 1)}`,
    freeSlots: Number.POSITIVE_INFINITY,
    mealPlan: [],
    now: "2026-10-26T13:00:00.000Z",
    records: [],
    ...overrides
  };
};

const restoreFrom = (json: string, context: RestoreContext) => {
  const validated = validateBackup(json);

  if (!validated.ok) {
    throw new Error(validated.error);
  }

  return planBackupRestore(validated.backup, readBackupExtras(JSON.parse(json)), context);
};

describe("backing up", () => {
  it("writes a backup the shared format accepts, leaving out untouched starters", () => {
    const { backup, recipeCount } = exported();
    const validated = validateBackup(JSON.stringify(backup));

    expect(recipeCount).toBe(2);
    expect(validated).toMatchObject({ ok: true, warnings: [] });
    expect(backup.app).toBe("LinkDish Android");
    expect(backup.recipes.map((entry) => entry.id)).toEqual(["saved-pasta", "saved-soup"]);
    expect(backup.recipes[0]?.meta).toEqual({
      cookLog: [{ cookedAt: "2026-10-10T19:00:00.000Z", note: "Less salt" }],
      createdAt: "2026-10-01T12:00:00.000Z",
      favorite: true,
      notes: "Use bucatini.",
      rating: 5,
      sourceUrl: "https://example.com/saved-pasta",
      tags: ["Weeknight", "Pasta"],
      timesCooked: 1,
      updatedAt: "2026-10-02T12:00:00.000Z"
    });
    expect(backup.collections).toEqual([
      expect.objectContaining({ id: "collection-weeknights", recipeIds: ["saved-pasta"] }),
      expect.objectContaining({ id: "collection-holidays", recipeIds: [] })
    ]);
    expect(backup.mealPlan).toEqual([
      {
        date: "2026-10-27",
        id: "plan-1",
        recipeId: "saved-pasta",
        servings: 2,
        slot: "dinner",
        title: "Recipe saved-pasta",
        updatedAt: "2026-10-21T08:00:00.000Z"
      }
    ]);
    expect(backup[BACKUP_EXTRAS_KEY].collections["collection-weeknights"]).toEqual({
      emoji: "🍝",
      sortOrder: 0
    });
  });

  it("keeps a starter someone made their own", () => {
    const { backup } = buildMobileBackup({
      collections: [],
      exportedAt: "2026-10-26T12:00:00.000Z",
      mealPlan: [],
      records: [{ ...plainStarter, favorite: true }]
    });

    expect(backup.recipes.map((entry) => entry.id)).toEqual([sample.id]);
  });

  it("names the file by the day", () => {
    expect(backupFileName(new Date(2026, 9, 6, 9))).toBe("linkdish-backup-2026-10-06.json");
  });
});

describe("restoring", () => {
  it("brings everything back onto an empty device", () => {
    const plan = restoreFrom(JSON.stringify(exported().backup), emptyDevice());

    expect(plan.counts).toEqual({
      collectionsCreated: 2,
      duplicates: 0,
      imported: 2,
      mealPlanAdded: 1,
      overLimit: 0,
      restoredStarters: 0
    });
    expect(plan.records[0]).toEqual({
      ...pasta,
      recipe: expect.objectContaining({ title: "Recipe saved-pasta" }) as unknown
    });
    expect(plan.collections).toEqual([weeknights, holidays]);
    expect(plan.collections[1]).not.toHaveProperty("emoji");
    expect(plan.mealPlan).toEqual([meal]);
  });

  it("keeps recipes already here, adding only their missing collections", () => {
    const here = { ...pasta, libraryExtras: { tags: ["Mine"] }, notes: "My notes" };
    const plan = restoreFrom(
      JSON.stringify(exported().backup),
      emptyDevice({ collections: [weeknights], records: [here] })
    );

    expect(plan.records.map((entry) => entry.id)).toEqual(["saved-soup"]);
    expect(plan.counts).toMatchObject({ duplicates: 1, imported: 1 });
    expect(plan.membershipAdditions).toEqual([
      { collectionIds: ["collection-weeknights"], recipeId: "saved-pasta" }
    ]);
    expect(plan.collections.map((entry) => entry.id)).toEqual(["collection-holidays"]);

    const elsewhere = restoreFrom(
      JSON.stringify(exported().backup),
      emptyDevice({
        records: [{ ...here, id: "saved-other-device" }]
      })
    );

    // The same link and title counts as the same recipe, and its meal follows it.
    expect(elsewhere.membershipAdditions).toEqual([
      { collectionIds: ["collection-weeknights"], recipeId: "saved-other-device" }
    ]);
    expect(elsewhere.mealPlan[0]?.recipeId).toBe("saved-other-device");
  });

  it("matches collections by name and skips meals already planned", () => {
    const plan = restoreFrom(
      JSON.stringify(exported().backup),
      emptyDevice({
        collections: [{ ...weeknights, id: "collection-mine", sortOrder: 4 }],
        mealPlan: [{ ...meal, id: "plan-mine" }],
        records: [pasta]
      })
    );

    expect(plan.membershipAdditions).toEqual([
      { collectionIds: ["collection-mine"], recipeId: "saved-pasta" }
    ]);
    expect(plan.collections).toEqual([
      expect.objectContaining({ id: "collection-holidays", sortOrder: 5 })
    ]);
    expect(plan.mealPlan).toEqual([]);
  });

  it("stops at the free limit but always brings back starters", () => {
    const { backup } = buildMobileBackup({
      collections: [],
      exportedAt: "2026-10-26T12:00:00.000Z",
      mealPlan: [],
      records: [record("a"), record("b"), { ...plainStarter, favorite: true }]
    });
    const plan = restoreFrom(JSON.stringify(backup), emptyDevice({ freeSlots: 1 }));

    expect(plan.records.map((entry) => [entry.id, entry.isStarter ?? false])).toEqual([
      ["a", false],
      [sample.id, true]
    ]);
    expect(plan.counts).toMatchObject({ imported: 1, overLimit: 1, restoredStarters: 1 });
  });

  it("replaces an untouched seeded starter with the backup's personalized copy", () => {
    const { backup } = buildMobileBackup({
      collections: [],
      exportedAt: "2026-10-26T12:00:00.000Z",
      mealPlan: [],
      records: [{ ...plainStarter, favorite: true, notes: "Double the garlic." }]
    });
    const fresh = restoreFrom(JSON.stringify(backup), emptyDevice({ records: [plainStarter] }));

    expect(fresh.records).toEqual([
      expect.objectContaining({
        favorite: true,
        id: sample.id,
        isStarter: true,
        notes: "Double the garlic."
      })
    ]);
    expect(fresh.counts).toMatchObject({ duplicates: 0, restoredStarters: 1 });

    // A starter someone already made their own here is kept.
    const mine = { ...plainStarter, notes: "Mine" };
    expect(
      restoreFrom(JSON.stringify(backup), emptyDevice({ records: [mine] })).counts
    ).toMatchObject({ duplicates: 1, restoredStarters: 0 });
  });

  it("keeps a duplicated recipe a copy of its original", () => {
    const original = record("orig");
    const copy = record("copy", {
      clonedFromId: "orig",
      recipe: { ...original.recipe, title: "Recipe orig, my way" }
    });
    const { backup } = buildMobileBackup({
      collections: [],
      exportedAt: "2026-10-26T12:00:00.000Z",
      mealPlan: [],
      records: [copy, original]
    });
    const json = JSON.stringify(backup);

    expect(restoreFrom(json, emptyDevice()).records).toEqual([
      expect.objectContaining({ clonedFromId: "orig", id: "copy" }),
      expect.not.objectContaining({ clonedFromId: expect.anything() as unknown })
    ]);

    // The original is already here under another id: the copy points at that one.
    const here = { ...original, id: "saved-here" };
    expect(restoreFrom(json, emptyDevice({ records: [here] })).records).toEqual([
      expect.objectContaining({ clonedFromId: "saved-here", id: "copy" })
    ]);
  });

  it("treats a recipe with the same id as the one already here", () => {
    const { backup } = buildMobileBackup({
      collections: [],
      exportedAt: "2026-10-26T12:00:00.000Z",
      mealPlan: [],
      records: [record("a")]
    });
    const other = {
      ...record("a"),
      recipe: { ...record("a").recipe, sourceUrl: "https://other.example/a", title: "Other" }
    };
    expect(
      restoreFrom(JSON.stringify(backup), emptyDevice({ records: [other] })).counts
    ).toMatchObject({
      duplicates: 1,
      imported: 0
    });
  });

  it("restores a web backup without extras with sensible defaults", () => {
    const { backup } = exported();
    const web = { ...backup, app: "LinkDish web", [BACKUP_EXTRAS_KEY]: undefined };
    const plan = restoreFrom(JSON.stringify(web), emptyDevice());

    expect(plan.records[0]).toMatchObject({
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    });
    expect(plan.records[0]?.libraryExtras).not.toHaveProperty("preferredServings");
    expect(plan.collections[0]).not.toHaveProperty("emoji");
  });

  it("reads damaged extras tolerantly", () => {
    expect(
      readBackupExtras({
        [BACKUP_EXTRAS_KEY]: {
          collections: { a: { emoji: 5, sortOrder: "x" }, b: { emoji: " 🍰 ", sortOrder: 2 } },
          mealPlan: { p: { createdAt: "yesterday" } },
          recipes: { r: { extraction: { fetchMode: "pigeon" }, preferredServings: -1 } },
          version: 1
        }
      })
    ).toEqual({
      collections: { a: {}, b: { emoji: "🍰", sortOrder: 2 } },
      mealPlan: { p: {} },
      recipes: { r: {} },
      version: 1
    });
    expect(readBackupExtras({ [BACKUP_EXTRAS_KEY]: { version: 2 } }).recipes).toEqual({});
  });

  it("says what a restore did", () => {
    expect(
      describeRestore({
        collectionsCreated: 1,
        duplicates: 2,
        imported: 3,
        mealPlanAdded: 4,
        overLimit: 1,
        restoredStarters: 0
      })
    ).toBe(
      "Restored 3 recipes, 1 collection and 4 planned meals. 2 recipes were already in your cookbook. 1 recipe didn't fit in the free cookbook."
    );
    expect(
      describeRestore({
        collectionsCreated: 0,
        duplicates: 1,
        imported: 0,
        mealPlanAdded: 0,
        overLimit: 0,
        restoredStarters: 0
      })
    ).toBe("Nothing new to restore. 1 recipe was already in your cookbook.");
  });

  it("says when entries in the file couldn't be read", () => {
    const counts = {
      collectionsCreated: 0,
      duplicates: 0,
      imported: 2,
      mealPlanAdded: 0,
      overLimit: 0,
      restoredStarters: 0
    };

    expect(describeRestore(counts, 1)).toBe(
      "Restored 2 recipes. 1 entry in the file couldn't be read and was skipped."
    );
    expect(describeRestore(counts, 3)).toBe(
      "Restored 2 recipes. 3 entries in the file couldn't be read and were skipped."
    );
  });
});
