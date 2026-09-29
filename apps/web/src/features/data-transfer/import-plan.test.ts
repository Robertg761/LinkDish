import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { describe, expect, it, vi } from "vitest";

import { analyzeImport } from "./import-plan";

import type { ImportCandidate, ParsedImportFile } from "./import-sources";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock("../../api/client", () => ({ apiClient: {} }));

const base = SAMPLE_RECIPES[0].recipe as Recipe;

const candidate = (index: number, sourceUrl: string, title: string): ImportCandidate => ({
  index,
  recipe: { ...base, sourceUrl, title },
  sourceUrl,
  sourceUrlSynthetic: false
});

const paprikaFile = (candidates: ImportCandidate[]): ParsedImportFile => ({
  candidates,
  collections: [],
  fileName: "export.paprikarecipes",
  mealPlan: [],
  photosSkipped: 0,
  scannedPhotoRecipes: 0,
  source: "paprika",
  unreadable: 0,
  warnings: []
});

const saved = (id: string, sourceUrl: string, title: string): WebSavedRecipe => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  id,
  recipe: { ...base, sourceUrl, title },
  sourceHost: new URL(sourceUrl).hostname,
  sourceUrl,
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-09-01T00:00:00.000Z"
});

describe("analyzeImport", () => {
  it("matches same-site look-alikes by title and link, in the file and in the cookbook", async () => {
    const analysis = await analyzeImport(
      paprikaFile([
        candidate(0, "https://cooking.example.com/recipes/1-lemon-pasta", "Lemon Pasta"),
        candidate(1, "https://www.cooking.example.com/recipes/1-lemon-pasta?utm_source=x", "Other"),
        candidate(2, "https://m.cooking.example.com/recipes/99", "lemon pasta!"),
        candidate(3, "https://cooking.example.com/recipes/2-soup", "Tomato Soup"),
        candidate(4, "https://cooking.example.com/recipes/3", "Lentil Stew"),
        candidate(5, "https://other.example.com/recipes/3", "Lentil Stew")
      ]),
      [saved("local-stew", "https://cooking.example.com/stews/lentil", "Lentil  Stew")]
    );

    expect(analysis.items.map((item) => item.duplicateOfIndex)).toEqual([
      null,
      0,
      0,
      null,
      null,
      null
    ]);
    expect(analysis.items.map((item) => item.duplicateOfLocalId)).toEqual([
      null,
      null,
      null,
      null,
      "local-stew",
      null
    ]);
  });

  it("stays fast for a big export from one site (no comparing every pair)", async () => {
    const count = 1_000;
    const candidates = Array.from({ length: count }, (_, index) =>
      candidate(index, `https://cooking.example.com/recipes/${index}`, `Weeknight dish ${index}`)
    );
    const cookbook = Array.from({ length: 200 }, (_, index) =>
      saved(`local-${index}`, `https://cooking.example.com/saved/${index}`, `Saved dish ${index}`)
    );

    const started = performance.now();
    const analysis = await analyzeImport(paprikaFile(candidates), cookbook);
    const elapsed = performance.now() - started;

    expect(analysis.items.every((item) => item.duplicateOfIndex === null)).toBe(true);
    // Comparing every same-site pair took minutes here (seconds in a browser); an index does not.
    expect(elapsed).toBeLessThan(4_000);
  }, 60_000);
});
