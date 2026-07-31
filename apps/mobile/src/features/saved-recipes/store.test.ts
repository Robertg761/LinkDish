import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain";
import { describe, expect, it } from "vitest";

import {
  cloneSavedRecipeRecord,
  createSharedRecipeSourceId,
  createSavedRecipeRecord,
  getQuotaSavedRecipeCount,
  incrementSavedRecipeTimesCooked,
  savedRecipeRecordToSharedRecipeRequest,
  parseSavedRecipeRecords,
  removeSavedRecipeRecord,
  restoreSavedRecipeState,
  searchSavedRecipeRecords,
  searchSharedRecipeRecords,
  serializeSavedRecipeRecords,
  successStateToSharedRecipeRequest,
  starterRecipeSeedRecordToSavedRecipeRecord,
  updateSavedRecipeRecord,
  upsertSavedRecipeRecord,
  markSavedRecipeShared,
  markSavedRecipeUnshared
} from "./store";

import type { SuccessfulExtractionState } from "../recipe-results/types";
import type { SharedRecipe } from "@linkdish/api-contracts";

const buildSuccessState = (
  overrides?: Partial<SuccessfulExtractionState>
): SuccessfulExtractionState => ({
  state: "success",
  fetchMode: "http",
  provenance: ["visible-text"],
  recipe: {
    title: "Soup",
    sourceUrl: "https://example.com/soup",
    sourceType: "article",
    ingredients: [{ text: "1 onion" }],
    steps: [{ index: 1, text: "Cook." }],
    servings: "4 servings",
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    nutrition: null,
    confidence: {
      score: 0.9,
      summary: "Confident extraction.",
      missingFields: [],
      notes: [],
      fieldProvenance: {
        title: "visible-text",
        ingredients: "visible-text",
        steps: "visible-text",
        servings: "visible-text",
        prepTimeMinutes: "visible-text",
        cookTimeMinutes: "visible-text",
        nutrition: null
      }
    }
  },
  strategy: "article-pattern",
  warnings: [],
  ...overrides
});

describe("saved recipe store helpers", () => {
  it("creates saved recipes with record ids", () => {
    const savedRecipe = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");

    expect(savedRecipe.id).toMatch(/^saved-/u);
    expect(savedRecipe.timesCooked).toBe(0);
  });

  it("restores a saved recipe back into a success state", () => {
    const state = buildSuccessState();
    const savedRecipe = createSavedRecipeRecord(state, "2026-04-19T12:00:00.000Z");

    expect(restoreSavedRecipeState(savedRecipe)).toEqual(state);
  });

  it("keeps scanned source images with personal saved recipes", () => {
    const state = buildSuccessState({
      recipe: {
        ...buildSuccessState().recipe,
        sourceUrl: "https://linkdish.app/image-imports/test",
        sourceType: "image"
      },
      sourceImages: [
        {
          dataUrl: "data:image/jpeg;base64,abc123",
          mimeType: "image/jpeg"
        }
      ]
    });
    const savedRecipe = createSavedRecipeRecord(state, "2026-04-19T12:00:00.000Z");

    expect(savedRecipe.sourceImages).toEqual(state.sourceImages);
    expect(restoreSavedRecipeState(savedRecipe).sourceImages).toEqual(state.sourceImages);
    expect(
      parseSavedRecipeRecords(serializeSavedRecipeRecords([savedRecipe]))[0]?.sourceImages
    ).toEqual(state.sourceImages);
  });

  it("moves an existing saved recipe to the front when saved again", () => {
    const baseRecipe = buildSuccessState().recipe;
    const soup = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const pasta = createSavedRecipeRecord(
      buildSuccessState({
        recipe: {
          ...baseRecipe,
          sourceUrl: "https://example.com/pasta",
          title: "Pasta"
        }
      }),
      "2026-04-19T12:05:00.000Z"
    );
    const refreshedSoup = createSavedRecipeRecord(
      buildSuccessState({
        recipe: {
          ...baseRecipe,
          title: "Better Soup"
        }
      }),
      "2026-04-19T12:10:00.000Z"
    );

    const updated = upsertSavedRecipeRecord([pasta, soup], refreshedSoup);

    expect(updated).toHaveLength(2);
    expect(updated[0]?.recipe.title).toBe("Better Soup");
    expect(updated[1]?.recipe.title).toBe("Pasta");
  });

  it("clones a saved recipe as an independent saved record", () => {
    const soup = {
      ...createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z"),
      notes: "Use the wide pot.",
      timesCooked: 4
    };
    const clone = cloneSavedRecipeRecord([soup], soup, "2026-04-19T12:15:00.000Z");

    expect(clone.id).not.toBe(soup.id);
    expect(clone.clonedFromId).toBe(soup.id);
    expect(clone.recipe.sourceUrl).toBe(soup.recipe.sourceUrl);
    expect(clone.recipe.title).toBe("Soup (Copy)");
    expect(clone.recipe.ingredients).toEqual(soup.recipe.ingredients);
    expect(clone.notes).toBe("Use the wide pot.");
    expect(clone.savedAt).toBe("2026-04-19T12:15:00.000Z");
    expect(clone.timesCooked).toBe(0);
    expect(clone.updatedAt).toBeUndefined();
  });

  it("increments the personal cooking count without changing other saved recipes", () => {
    const soup = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const pasta = createSavedRecipeRecord(
      buildSuccessState({
        recipe: {
          ...buildSuccessState().recipe,
          sourceUrl: "https://example.com/pasta",
          title: "Pasta"
        }
      }),
      "2026-04-19T12:05:00.000Z"
    );

    const updated = incrementSavedRecipeTimesCooked([soup, pasta], soup.id);

    expect(updated[0]?.timesCooked).toBe(1);
    expect(updated[1]).toBe(pasta);
  });

  it("keeps starter recipes quota-free and clones them as ordinary records", () => {
    const starter = starterRecipeSeedRecordToSavedRecipeRecord(
      createStarterRecipeSeedRecords("2026-04-19T12:00:00.000Z")[0]!
    );
    const savedRecipe = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:05:00.000Z");
    const clone = cloneSavedRecipeRecord([starter], starter, "2026-04-19T12:10:00.000Z");

    expect(starter.isStarter).toBe(true);
    expect(getQuotaSavedRecipeCount([starter, savedRecipe])).toBe(1);
    expect(clone.isStarter).toBeUndefined();
    expect(getQuotaSavedRecipeCount([starter, clone])).toBe(1);
  });

  it("increments repeated clone titles", () => {
    const soup = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const firstClone = {
      ...cloneSavedRecipeRecord([soup], soup, "2026-04-19T12:15:00.000Z"),
      id: "first-clone"
    };
    const secondClone = cloneSavedRecipeRecord(
      [firstClone, soup],
      soup,
      "2026-04-19T12:20:00.000Z"
    );

    expect(firstClone.recipe.title).toBe("Soup (Copy)");
    expect(secondClone.recipe.title).toBe("Soup (Copy 2)");
  });

  it("removes a saved recipe by id without removing clones from the same source", () => {
    const baseRecipe = buildSuccessState().recipe;
    const soup = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const soupClone = cloneSavedRecipeRecord([soup], soup, "2026-04-19T12:05:00.000Z");
    const pasta = createSavedRecipeRecord(
      buildSuccessState({
        recipe: {
          ...baseRecipe,
          sourceUrl: "https://example.com/pasta",
          title: "Pasta"
        }
      }),
      "2026-04-19T12:10:00.000Z"
    );

    expect(removeSavedRecipeRecord([soupClone, soup, pasta], soup.id)).toEqual([soupClone, pasta]);
  });

  it("updates a saved recipe copy by id with tweaks and personal notes", () => {
    const soup = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const soupClone = cloneSavedRecipeRecord([soup], soup, "2026-04-19T12:05:00.000Z");
    const updated = updateSavedRecipeRecord([soupClone, soup], soupClone.id, {
      notes: "Use the wide pot.",
      recipe: {
        ...soupClone.recipe,
        title: "Weeknight Soup",
        ingredients: [{ text: "2 onions" }]
      },
      updatedAt: "2026-04-19T12:15:00.000Z"
    });

    expect(updated[0]?.recipe.title).toBe("Weeknight Soup");
    expect(updated[0]?.recipe.ingredients[0]?.text).toBe("2 onions");
    expect(updated[0]?.notes).toBe("Use the wide pot.");
    expect(updated[0]?.updatedAt).toBe("2026-04-19T12:15:00.000Z");
    expect(updated[1]?.recipe.title).toBe("Soup");
  });

  it("searches saved recipes across title, source, ingredients, method, and notes", () => {
    const baseRecipe = buildSuccessState().recipe;
    const soup = {
      ...createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z"),
      notes: "Great with lemon."
    };
    const pasta = createSavedRecipeRecord(
      buildSuccessState({
        recipe: {
          ...baseRecipe,
          sourceUrl: "https://example.com/pasta",
          title: "Pasta",
          ingredients: [{ text: "Tomatoes" }],
          steps: [{ index: 1, text: "Simmer sauce." }]
        }
      }),
      "2026-04-19T12:05:00.000Z"
    );

    expect(searchSavedRecipeRecords([soup, pasta], "lemon")[0]?.recipe.title).toBe("Soup");
    expect(searchSavedRecipeRecords([soup, pasta], "tomatoes simmer")[0]?.recipe.title).toBe(
      "Pasta"
    );
    expect(
      searchSavedRecipeRecords([soup, pasta], "example").map((entry) => entry.recipe.title)
    ).toEqual(["Soup", "Pasta"]);
  });

  it("returns cloned recipes independently in search results", () => {
    const soup = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const soupClone = cloneSavedRecipeRecord([soup], soup, "2026-04-19T12:05:00.000Z");

    expect(searchSavedRecipeRecords([soupClone, soup], "soup")).toHaveLength(2);
  });

  it("round-trips saved recipes through storage serialization", () => {
    const recipes = [
      createSavedRecipeRecord(
        buildSuccessState({
          recipe: {
            ...buildSuccessState().recipe,
            image: {
              height: 720,
              source: "og",
              url: "https://example.com/soup.jpg",
              width: 960
            }
          }
        }),
        "2026-04-19T12:00:00.000Z"
      )
    ];

    expect(parseSavedRecipeRecords(serializeSavedRecipeRecords(recipes))).toEqual(recipes);
  });

  it("uses a stable source key for original shared recipe requests", () => {
    const state = buildSuccessState();
    const savedRecipe = createSavedRecipeRecord(state, "2026-04-19T12:00:00.000Z");
    const expectedSourceId = createSharedRecipeSourceId(state.recipe.sourceUrl);

    expect(successStateToSharedRecipeRequest(state).sourceSavedRecipeId).toBe(expectedSourceId);
    expect(savedRecipeRecordToSharedRecipeRequest(savedRecipe).sourceSavedRecipeId).toBe(
      expectedSourceId
    );
  });

  it("does not include scanned image payloads in shared recipe requests", () => {
    const state = buildSuccessState({
      sourceImages: [
        {
          dataUrl: "data:image/jpeg;base64,abc123",
          mimeType: "image/jpeg"
        }
      ]
    });
    const savedRecipe = createSavedRecipeRecord(state, "2026-04-19T12:00:00.000Z");

    expect(savedRecipeRecordToSharedRecipeRequest(savedRecipe)).not.toHaveProperty("sourceImages");
    expect(successStateToSharedRecipeRequest(state)).not.toHaveProperty("sourceImages");
  });

  it("uses clone ids when sharing independent saved copies", () => {
    const savedRecipe = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const clone = cloneSavedRecipeRecord([savedRecipe], savedRecipe, "2026-04-19T12:05:00.000Z");

    expect(savedRecipeRecordToSharedRecipeRequest(clone).sourceSavedRecipeId).toBe(clone.id);
  });

  it("marks personal recipes as shared and unshared", () => {
    const savedRecipe = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const sharedRecipe: SharedRecipe = {
      createdAt: "2026-04-19T12:05:00.000Z",
      fetchMode: savedRecipe.fetchMode,
      householdId: "household_1",
      id: "shared_recipe_1",
      ownerEmail: "owner@example.com",
      ownerUserId: "user_1",
      provenance: ["visible-text"],
      recipe: savedRecipe.recipe,
      sourceSavedRecipeId: savedRecipe.id,
      strategy: "article-pattern",
      updatedAt: "2026-04-19T12:05:00.000Z",
      warnings: []
    };

    const shared = markSavedRecipeShared([savedRecipe], savedRecipe.id, sharedRecipe);

    expect(shared[0]?.sharedRecipeId).toBe("shared_recipe_1");
    expect(markSavedRecipeUnshared(shared, savedRecipe.id)[0]?.sharedRecipeId).toBeUndefined();
  });

  it("searches shared recipes while preserving shared ownership metadata", () => {
    const savedRecipe = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const sharedRecipe: SharedRecipe = {
      createdAt: "2026-04-19T12:05:00.000Z",
      fetchMode: savedRecipe.fetchMode,
      householdId: "household_1",
      id: "shared_recipe_1",
      ownerEmail: "owner@example.com",
      ownerUserId: "user_1",
      provenance: ["visible-text"],
      recipe: savedRecipe.recipe,
      sourceSavedRecipeId: savedRecipe.id,
      strategy: "article-pattern",
      updatedAt: "2026-04-19T12:05:00.000Z",
      warnings: []
    };

    expect(searchSharedRecipeRecords([sharedRecipe], "onion")[0]?.ownerEmail).toBe(
      "owner@example.com"
    );
  });

  it("normalizes legacy saved recipes without ids", () => {
    const legacyRecipe = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const legacyPayload: Partial<typeof legacyRecipe> = { ...legacyRecipe };
    delete legacyPayload.id;

    expect(parseSavedRecipeRecords(JSON.stringify([legacyPayload]))[0]?.id).toBe(
      legacyRecipe.recipe.sourceUrl
    );
    expect(parseSavedRecipeRecords(JSON.stringify([legacyPayload]))[0]?.timesCooked).toBe(0);
  });

  it("normalizes legacy saved recipe images additively", () => {
    const legacyRecipe = createSavedRecipeRecord(buildSuccessState(), "2026-04-19T12:00:00.000Z");
    const legacyPayload = {
      ...legacyRecipe,
      recipe: {
        ...legacyRecipe.recipe
      }
    };
    delete legacyPayload.recipe.image;

    expect(parseSavedRecipeRecords(JSON.stringify([legacyPayload]))[0]?.recipe.image).toBeNull();
  });

  it("drops invalid saved recipe payloads", () => {
    expect(parseSavedRecipeRecords('[{"savedAt":"2026-04-19T12:00:00.000Z"}]')).toEqual([]);
    expect(parseSavedRecipeRecords("not json")).toEqual([]);
  });
});
