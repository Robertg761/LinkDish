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
import { putSavedRecipe } from "../library/saved-recipe-store";

import { WEB_BACKUP_EXTRAS_KEY } from "./backup-format";
import { downloadBackup } from "./data-transfer";

import type { WebLinkDishBackup } from "./backup-export";
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
  const collections = await import("../../data/collections-store");
  const store = await import("../library/saved-recipe-store");
  await (await import("../../storage/linkdish-db")).getLinkDishWebDb();
  feed.setDataChannelFactoryForTests(() => null);
  return { collections, store };
};

const scan = (name: string) => ({
  dataUrl: `data:image/jpeg;base64,${name}`,
  mimeType: "image/jpeg" as const
});

const saved = (id: string, overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
  id,
  recipe: {
    ...(SAMPLE_RECIPES[0].recipe as Recipe),
    sourceUrl: `https://example.com/${id}`,
    title: `Recipe ${id}`
  },
  sourceHost: "example.com",
  sourceUrl: `https://example.com/${id}`,
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...overrides
});

/** Captures the file `downloadBackup` hands to the browser. */
const captureDownload = () => {
  const blobs: Blob[] = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:test-${blobs.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  return async (): Promise<WebLinkDishBackup> => {
    const blob = blobs.at(-1);
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error as Error);
      reader.readAsText(blob!);
    });
    return JSON.parse(text) as WebLinkDishBackup;
  };
};

describe("backups made while another tab writes", () => {
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

  it("backs up a recipe with the scans it had at that moment", async () => {
    const readBackup = captureDownload();
    await putSavedRecipe(saved("mine", { notes: "First version", sourceImages: [scan("A")] }));
    const other = await openOtherTab();
    let replacing: Promise<unknown> | undefined;
    // Right after the backup read the recipes, the other tab saves a new version with new scans.
    fakeIdb.afterNextGetAll(SAVED_RECIPES_STORE_NAME, () => {
      replacing = other.store.putSavedRecipe(
        saved("mine", { notes: "Second version", sourceImages: [scan("B")] })
      );
    });

    await downloadBackup({ includeImages: true });
    await replacing;

    const backup = await readBackup();
    expect({
      notes: backup.recipes[0]?.meta.notes,
      scans: backup[WEB_BACKUP_EXTRAS_KEY].sourceImages?.mine
    }).toEqual({ notes: "First version", scans: [scan("A")] });
  });

  it("backs up a recipe's collections as they were when its recipes were read", async () => {
    const readBackup = captureDownload();
    const soups = await createCollection({ name: "Soups" });
    await putSavedRecipe(saved("mine", { collectionIds: [soups.id] }));
    const other = await openOtherTab();
    let deleting: Promise<unknown> | undefined;
    // Right after the backup read the recipes, the other tab deletes the collection.
    fakeIdb.afterNextGetAll(SAVED_RECIPES_STORE_NAME, () => {
      deleting = other.collections.deleteCollection(soups.id);
    });

    await downloadBackup({ includeImages: false });
    await deleting;

    const backup = await readBackup();
    expect(backup.collections?.map((collection) => collection.recipeIds)).toEqual([["mine"]]);
  });
});
