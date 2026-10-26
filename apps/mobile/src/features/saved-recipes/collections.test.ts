import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { describe, expect, it } from "vitest";

import {
  CollectionValidationError,
  collectCookbookTags,
  countRecipesByCollection,
  createCollectionRecord,
  normalizeRecipeTags,
  parseCollections,
  removeCollectionFromRecords,
  setSavedRecipeCollectionIds,
  setSavedRecipeTags,
  sortCollections,
  updateCollectionRecord,
  type MobileCollection
} from "./collections";

import type { SavedRecipeRecord } from "./store";

const sample = SAMPLE_RECIPES[0];

const record = (id: string, overrides: Partial<SavedRecipeRecord> = {}): SavedRecipeRecord => ({
  fetchMode: "http",
  id,
  provenance: ["jsonld"],
  recipe: { ...sample.recipe, sourceUrl: `https://example.com/${id}`, title: id },
  savedAt: "2026-10-01T12:00:00.000Z",
  strategy: "recipe-schema",
  timesCooked: 0,
  warnings: [],
  ...overrides
});

const now = new Date("2026-10-26T12:00:00.000Z");

describe("collections", () => {
  it("adds a collection at the end of the order with a cleaned-up name", () => {
    const first = createCollectionRecord([], { emoji: " 🍝 ", name: "  Pasta   night " }, now);
    const second = createCollectionRecord([first], { name: "Soups", description: "  " }, now);

    expect(first).toMatchObject({ emoji: "🍝", name: "Pasta night", sortOrder: 0 });
    expect(second).toMatchObject({ name: "Soups", sortOrder: 1 });
    expect(second).not.toHaveProperty("description");
    expect(first.id).not.toBe(second.id);
  });

  it("refuses a collection without a name or with a long one", () => {
    expect(() => createCollectionRecord([], { name: "   " })).toThrow(CollectionValidationError);
    expect(() => createCollectionRecord([], { name: "x".repeat(61) })).toThrow(
      "Collection names can be up to 60 characters."
    );
  });

  it("changes only the fields asked for and removes an emptied emoji", () => {
    const collection = createCollectionRecord([], { emoji: "🍝", name: "Pasta" }, now);
    const later = new Date("2026-10-27T12:00:00.000Z");

    expect(updateCollectionRecord(collection, { emoji: "", name: "Noodles" }, later)).toEqual({
      ...collection,
      emoji: undefined,
      name: "Noodles",
      updatedAt: later.toISOString()
    });
  });

  it("orders by sort order, then name", () => {
    const make = (name: string, sortOrder: number): MobileCollection => ({
      createdAt: now.toISOString(),
      id: name,
      name,
      sortOrder,
      updatedAt: now.toISOString()
    });

    expect(
      sortCollections([make("b", 1), make("Z", 0), make("a", 1)]).map((entry) => entry.name)
    ).toEqual(["Z", "a", "b"]);
  });

  it("reads stored collections defensively", () => {
    expect(parseCollections(null)).toEqual([]);
    expect(parseCollections("not json")).toEqual([]);
    expect(
      parseCollections(
        JSON.stringify([
          { createdAt: "2026-10-01T00:00:00.000Z", id: "c1", name: "Soups" },
          { id: "c2" },
          null
        ])
      )
    ).toEqual([
      {
        createdAt: "2026-10-01T00:00:00.000Z",
        id: "c1",
        name: "Soups",
        sortOrder: 0,
        updatedAt: "2026-10-01T00:00:00.000Z"
      }
    ]);
  });
});

describe("tags and membership", () => {
  it("cleans up, deduplicates and caps tags", () => {
    expect(normalizeRecipeTags([" Weeknight ", "weeknight", "", "Quick  and   easy"])).toEqual([
      "Weeknight",
      "Quick and easy"
    ]);
    expect(normalizeRecipeTags(Array.from({ length: 30 }, (_, index) => `t${index}`))).toHaveLength(
      20
    );
  });

  it("sets tags and collections on one recipe and keeps its other synced fields", () => {
    const records = [record("a", { libraryExtras: { rating: 4 } }), record("b")];
    const tagged = setSavedRecipeTags(records, "a", ["Soup", "soup", "Quick"]);
    const filed = setSavedRecipeCollectionIds(tagged, "a", ["c1", "c1", "c2"]);

    expect(filed[0]?.libraryExtras).toEqual({
      collectionIds: ["c1", "c2"],
      rating: 4,
      tags: ["Soup", "Quick"]
    });
    expect(filed[1]).toBe(records[1]);
    expect(setSavedRecipeTags(filed, "a", [])[0]?.libraryExtras).not.toHaveProperty("tags");
  });

  it("takes a deleted collection off every recipe", () => {
    const records = [
      record("a", { libraryExtras: { collectionIds: ["c1", "c2"] } }),
      record("b", { libraryExtras: { collectionIds: ["c1"] } }),
      record("c")
    ];
    const next = removeCollectionFromRecords(records, "c1");

    expect(next.map((entry) => entry.libraryExtras)).toEqual([
      { collectionIds: ["c2"] },
      undefined,
      undefined
    ]);
    expect(removeCollectionFromRecords(next, "c1")).toBe(next);
  });

  it("counts collection members and cookbook tags", () => {
    const records = [
      record("a", { libraryExtras: { collectionIds: ["c1"], tags: ["Soup", "Quick"] } }),
      record("b", { libraryExtras: { collectionIds: ["c1", "c2"], tags: ["quick"] } })
    ];

    expect(Object.fromEntries(countRecipesByCollection(records))).toEqual({ c1: 2, c2: 1 });
    expect(collectCookbookTags(records)).toEqual([
      { count: 2, label: "Quick" },
      { count: 1, label: "Soup" }
    ]);
  });
});
