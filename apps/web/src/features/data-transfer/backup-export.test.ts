import { linkdishBackupSchema, SAMPLE_RECIPES, validateBackup } from "@linkdish/recipe-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { createCollection, getCollections } from "../../data/collections-store";
import { addMealPlanEntry, getMealPlanEntries } from "../../data/meal-plan-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import {
  getSavedRecipeById,
  getSavedRecipes,
  logRecipeCooked,
  putSavedRecipe,
  setRecipeCollections,
  setRecipeFavorite,
  setRecipeRating,
  setRecipeTags
} from "../library/saved-recipe-store";

import {
  backupFileName,
  buildBackup,
  buildCookbookMarkdown,
  cookbookFileName
} from "./backup-export";
import { WEB_BACKUP_EXTRAS_KEY } from "./backup-format";
import { downloadBackup, downloadCookbookText, prepareImport, runImport } from "./data-transfer";
import { selectExportRecipes } from "./export-selection";
import { readLastBackupAt } from "./last-backup";
import { loadExportSnapshot } from "./local-data";
import { fileFromBytes, utf8Bytes } from "./testing/zip-fixtures";

import type { WebLinkDishBackup } from "./backup-export";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
vi.mock("../../api/client", () => ({ apiClient: {} }));

const analytics = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));
vi.mock("../../analytics/client", () => ({ trackWebEvent: analytics.trackWebEvent }));

const skillet = SAMPLE_RECIPES[0].recipe as Recipe;
const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==";

const saved = (id: string, overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => ({
  id,
  recipe: { ...skillet, title: `Recipe ${id}`, sourceUrl: `https://example.com/${id}` },
  sourceUrl: `https://example.com/${id}`,
  sourceHost: "example.com",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  extraction: {
    fetchMode: "browser",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  timesCooked: 0,
  sync: { status: "local_only" },
  ...overrides
});

const starter = (index: number, overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => {
  const sample = SAMPLE_RECIPES[index]!;
  return saved(sample.id, {
    recipe: sample.recipe as Recipe,
    sourceUrl: sample.recipe.sourceUrl,
    sourceHost: new URL(sample.recipe.sourceUrl).hostname,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    isStarter: true,
    ...overrides
  });
};

/** Captures what downloadTextFile hands to the browser. */
const captureDownloads = () => {
  const downloads: Array<{ name: string; blob: Blob }> = [];
  let counter = 0;
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = vi.fn((blob: Blob) => {
    counter += 1;
    const url = `blob:test-${counter}`;
    blobs.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    const blob = blobs.get(this.href);
    if (blob) {
      downloads.push({ name: this.download, blob });
    }
  });
  return downloads;
};

const blobText = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error as Error);
    reader.readAsText(blob);
  });

describe("backups", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    window.localStorage.clear();
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

  it("leaves out starter recipes nobody made their own", () => {
    const recipes = [
      saved("mine"),
      starter(0),
      starter(1, { favorite: true }),
      starter(2, { updatedAt: "2026-09-05T00:00:00.000Z" })
    ];

    expect(selectExportRecipes(recipes).map((recipe) => recipe.id)).toEqual([
      "mine",
      SAMPLE_RECIPES[1].id,
      SAMPLE_RECIPES[2].id
    ]);
  });

  it("builds a valid, versioned backup with every personal detail", () => {
    const recipe = saved("mine", {
      favorite: true,
      tags: ["weeknight", "rice"],
      rating: 4,
      notes: "  Extra lime.  ",
      timesCooked: 2,
      cookLog: [{ cookedAt: "2026-09-10T18:00:00.000Z", note: "Kids loved it" }],
      lastCookedAt: "2026-09-10T18:00:00.000Z",
      collectionIds: ["c1"],
      preferredServings: 6,
      sourceImageCount: 1
    });
    const built = buildBackup(
      {
        recipes: [recipe, starter(0)],
        collections: [
          {
            id: "c1",
            name: "Weeknights",
            emoji: "🌙",
            sortOrder: 2,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z"
          }
        ],
        mealPlan: [
          {
            id: "m1",
            date: "2026-09-28",
            slot: "dinner",
            recipeId: "mine",
            title: "Recipe mine",
            servings: 4,
            createdAt: "2026-09-26T00:00:00.000Z",
            updatedAt: "2026-09-26T00:00:00.000Z"
          }
        ]
      },
      {
        exportedAt: "2026-09-28T09:00:00.000Z",
        includeImages: false,
        sourceImages: new Map([["mine", [{ dataUrl: TINY_JPEG, mimeType: "image/jpeg" as const }]]])
      }
    );

    expect(linkdishBackupSchema.safeParse(built.backup).success).toBe(true);
    expect(validateBackup(JSON.parse(JSON.stringify(built.backup)))).toMatchObject({
      ok: true,
      warnings: []
    });
    expect(built.recipeCount).toBe(1);
    expect(built.imageCount).toBe(0);
    expect(built.backup).toMatchObject({
      format: "linkdish-backup",
      version: 1,
      exportedAt: "2026-09-28T09:00:00.000Z",
      app: "LinkDish web",
      recipes: [
        {
          id: "mine",
          meta: {
            favorite: true,
            tags: ["weeknight", "rice"],
            rating: 4,
            notes: "Extra lime.",
            timesCooked: 2,
            cookLog: [{ cookedAt: "2026-09-10T18:00:00.000Z", note: "Kids loved it" }],
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z",
            sourceUrl: "https://example.com/mine"
          }
        }
      ],
      collections: [{ id: "c1", name: "Weeknights", recipeIds: ["mine"] }],
      mealPlan: [{ id: "m1", date: "2026-09-28", slot: "dinner", recipeId: "mine", servings: 4 }]
    });
    expect(built.backup[WEB_BACKUP_EXTRAS_KEY]).toMatchObject({
      version: 1,
      recipes: {
        mine: {
          preferredServings: 6,
          lastCookedAt: "2026-09-10T18:00:00.000Z",
          extraction: { fetchMode: "browser" }
        }
      },
      collections: { c1: { emoji: "🌙", sortOrder: 2 } },
      mealPlan: { m1: { createdAt: "2026-09-26T00:00:00.000Z" } }
    });
    expect(built.backup[WEB_BACKUP_EXTRAS_KEY].sourceImages).toBeUndefined();
  });

  it("adds original scans only when asked", () => {
    const snapshot = {
      recipes: [saved("scan", { sourceImageCount: 1 })],
      collections: [],
      mealPlan: []
    };
    const sourceImages = new Map([
      ["scan", [{ dataUrl: TINY_JPEG, mimeType: "image/jpeg" as const }]]
    ]);

    const withImages = buildBackup(snapshot, {
      exportedAt: "2026-09-28T09:00:00.000Z",
      includeImages: true,
      sourceImages
    });

    expect(withImages.imageCount).toBe(1);
    expect(withImages.backup[WEB_BACKUP_EXTRAS_KEY].sourceImages).toEqual({
      scan: [{ dataUrl: TINY_JPEG, mimeType: "image/jpeg" }]
    });
  });

  it("names files by the local date", () => {
    const date = new Date(2026, 8, 5, 23, 30);

    expect(backupFileName(date)).toBe("linkdish-backup-2026-09-05.json");
    expect(cookbookFileName(date)).toBe("linkdish-cookbook-2026-09-05.md");
  });

  it("exports the cookbook as readable Markdown", () => {
    const markdown = buildCookbookMarkdown(
      [
        saved("b", {
          recipe: { ...skillet, title: "Zesty Noodles" },
          favorite: true,
          rating: 4,
          tags: ["quick"],
          notes: "Add more lime."
        }),
        saved("a", { recipe: { ...skillet, title: "Apple Cake" } }),
        starter(1)
      ],
      { exportedAt: new Date(2026, 8, 28) }
    );

    expect(
      markdown.startsWith("# My LinkDish cookbook\n\n_2 recipes · exported September 28, 2026_")
    ).toBe(true);
    expect(markdown.indexOf("## Apple Cake")).toBeLessThan(markdown.indexOf("## Zesty Noodles"));
    expect(markdown).toContain("## Zesty Noodles\n\n_♥ Favorite · ★★★★☆ · Tags: quick_");
    expect(markdown).toContain("### Ingredients");
    expect(markdown).toContain("### Notes\n\nAdd more lime.");
    expect(markdown).toContain("\n\n---\n\n");
    expect(markdown).not.toContain(SAMPLE_RECIPES[1].recipe.title);
  });

  it("downloads a backup, remembers when, and records library_exported", async () => {
    const downloads = captureDownloads();
    await putSavedRecipe(
      saved("mine", { sourceImages: [{ dataUrl: TINY_JPEG, mimeType: "image/jpeg" }] })
    );
    await putSavedRecipe(starter(0));

    const summary = await downloadBackup({ includeImages: true, now: new Date(2026, 8, 28, 10) });

    expect(summary).toMatchObject({
      fileName: "linkdish-backup-2026-09-28.json",
      recipeCount: 1,
      imageCount: 1
    });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.blob.type).toBe("application/json");
    const file = JSON.parse(await blobText(downloads[0]!.blob)) as WebLinkDishBackup;
    expect(file.recipes.map((recipe) => recipe.id)).toEqual(["mine"]);
    expect(file[WEB_BACKUP_EXTRAS_KEY].sourceImages?.mine).toHaveLength(1);
    expect(readLastBackupAt()).toBe(new Date(2026, 8, 28, 10).toISOString());
    expect(analytics.trackWebEvent).toHaveBeenCalledWith({
      eventName: "library_exported",
      routeOrScreen: "/settings",
      properties: { recipe_count: 1, include_images: true, format: "backup" }
    });
  });

  it("downloads the Markdown cookbook", async () => {
    const downloads = captureDownloads();
    await putSavedRecipe(saved("mine", { recipe: { ...skillet, title: "Weeknight Rice" } }));

    const summary = await downloadCookbookText({ now: new Date(2026, 8, 28) });

    expect(summary).toMatchObject({ fileName: "linkdish-cookbook-2026-09-28.md", recipeCount: 1 });
    expect(await blobText(downloads[0]!.blob)).toContain("## Weeknight Rice");
    expect(analytics.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "library_exported",
        properties: { recipe_count: 1, include_images: false, format: "markdown" }
      })
    );
  });

  it("round-trips: export, clear the device, import — everything comes back", async () => {
    const downloads = captureDownloads();
    await putSavedRecipe(
      saved("mine", { sourceImages: [{ dataUrl: TINY_JPEG, mimeType: "image/jpeg" }] })
    );
    await putSavedRecipe(saved("other", { notes: "Freezes well." }));
    await putSavedRecipe(starter(0));
    await putSavedRecipe(starter(1));
    const collection = await createCollection({ name: "Weeknights", emoji: "🌙" });
    await setRecipeCollections("mine", [collection.id]);
    await setRecipeFavorite("mine", true);
    await setRecipeTags("mine", ["rice", "quick"]);
    await setRecipeRating("mine", 5);
    await logRecipeCooked("mine", { cookedAt: "2026-09-20T18:00:00.000Z", note: "Perfect" });
    await setRecipeFavorite(SAMPLE_RECIPES[1].id, true);
    await addMealPlanEntry({
      date: "2026-09-29",
      slot: "dinner",
      recipeId: "mine",
      title: "Recipe mine"
    });
    const before = await loadExportSnapshot();

    await downloadBackup({ includeImages: true });
    const backupText = await blobText(downloads[0]!.blob);

    // A new device: empty storage.
    fakeIdb.reset();
    resetLinkDishWebDbForTests();

    const prepared = await prepareImport(fileFromBytes(utf8Bytes(backupText), "backup.json"));
    const result = await runImport(prepared, { duplicateMode: "skip", isPremium: false });

    expect(result.plan.counts).toMatchObject({ imported: 2, restoredStarters: 1, overLimit: 0 });
    const after = await getSavedRecipes();
    const strip = (recipe: WebSavedRecipe) => {
      const rest: Partial<WebSavedRecipe> = { ...recipe };
      delete rest.sync;
      return rest;
    };
    // Everything but the untouched starter comes back exactly (ids, metadata, timestamps).
    const expected = before.recipes
      .filter((recipe) => recipe.id !== SAMPLE_RECIPES[0].id)
      .map(strip);

    expect(after).toHaveLength(3);
    expect(after.map(strip)).toEqual(expect.arrayContaining(expected));
    expect(await getCollections()).toEqual([collection]);
    expect((await getSavedRecipeById("mine"))?.sourceImages).toEqual([
      { dataUrl: TINY_JPEG, mimeType: "image/jpeg" }
    ]);
    expect(await getMealPlanEntries()).toEqual([
      expect.objectContaining({ date: "2026-09-29", slot: "dinner", recipeId: "mine" })
    ]);
  });
});
