import { describe, expect, it } from "vitest";

import {
  buildVideoRecipeCandidate,
  isAmountSupported,
  isItemNamedIn,
  readStatedNumbers
} from "./build-video-recipe-candidate";

import type { VideoRecipePayload } from "./video-recipe-payload";

const context = {
  platform: "tiktok" as const,
  caption: "Garlic butter noodles 🍜 #pasta",
  title: null,
  authorName: "Cook Creator"
};

const options = {
  context,
  fallbackTitle: "TikTok recipe from Cook Creator",
  recipe: { sourceUrl: "https://www.tiktok.com/@cook/video/1", siteName: "TikTok" }
};

const payload = (overrides: Partial<VideoRecipePayload> = {}): VideoRecipePayload => ({
  recipeInVideo: true,
  notRecipeReason: null,
  title: "Garlic Butter Noodles",
  servings: null,
  prepTimeMinutes: null,
  cookTimeMinutes: null,
  ingredients: [
    {
      item: "spaghetti",
      amount: "8 oz",
      section: null,
      source: "on_screen_text",
      quote: "8 oz spaghetti"
    },
    {
      item: "garlic, minced",
      amount: "4 cloves",
      section: null,
      source: "speech",
      quote: "then four cloves of garlic, minced"
    },
    {
      item: "butter",
      amount: "1/2 cup",
      section: null,
      source: "speech",
      quote: "half a cup of butter"
    }
  ],
  steps: [
    { text: "Boil the spaghetti.", source: "speech", quote: "boil your spaghetti" },
    { text: "Melt the butter with the garlic.", source: "visual", quote: "butter melting" }
  ],
  ...overrides
});

describe("readStatedNumbers", () => {
  it("reads digits, fractions, number words and mixed numbers", () => {
    expect(readStatedNumbers("2 cups")).toEqual([2]);
    expect(readStatedNumbers("1 1/2 cups")).toEqual([1.5, 1, 0.5]);
    expect(readStatedNumbers("1½ cups")).toEqual([1.5, 1, 0.5]);
    expect(readStatedNumbers("one and a half cups")).toContain(1.5);
    expect(readStatedNumbers("half a cup")).toContain(0.5);
    expect(readStatedNumbers("200g")).toEqual([200]);
    expect(readStatedNumbers("2-3 cloves")).toEqual([2, 3]);
  });
});

describe("isAmountSupported", () => {
  it("accepts an amount the quote states in other words", () => {
    expect(isAmountSupported("1/2 cup", "half a cup of butter")).toBe(true);
    expect(isAmountSupported("4 cloves", "four cloves of garlic")).toBe(true);
    expect(isAmountSupported("1 1/2 cups", "one and a half cups of milk")).toBe(true);
    expect(isAmountSupported("1 cup", "a cup of rice")).toBe(true);
    expect(isAmountSupported("a pinch", "a pinch of salt")).toBe(true);
    expect(isAmountSupported("to taste", "salt to taste")).toBe(true);
  });

  it("rejects an amount the quote does not state", () => {
    expect(isAmountSupported("2 tbsp", "some soy sauce")).toBe(false);
    expect(isAmountSupported("1 tsp", "a splash of vinegar")).toBe(false);
    expect(isAmountSupported("3 cups", "two cups of flour")).toBe(false);
    expect(isAmountSupported("a handful", "some spinach")).toBe(false);
  });
});

describe("isItemNamedIn", () => {
  it("matches an ingredient word, loosely stemmed", () => {
    expect(isItemNamedIn("cherry tomatoes", "a punnet of cherry tomato")).toBe(true);
    expect(isItemNamedIn("garlic, minced", "four cloves of garlic")).toBe(true);
    expect(isItemNamedIn("heavy cream", "a splash of milk")).toBe(false);
  });
});

describe("buildVideoRecipeCandidate", () => {
  it("builds a recipe from evidence-backed ingredients and steps", () => {
    const { candidate, rejections } = buildVideoRecipeCandidate(payload(), options);

    expect(rejections).toEqual([]);
    expect(candidate).toMatchObject({
      strategy: "llm-fallback",
      provenance: ["llm"],
      warnings: [],
      recipe: {
        title: "Garlic Butter Noodles",
        siteName: "TikTok",
        ingredients: [
          { text: "8 oz spaghetti" },
          { text: "4 cloves garlic, minced" },
          { text: "1/2 cup butter" }
        ],
        steps: [
          { index: 1, text: "Boil the spaghetti." },
          { index: 2, text: "Melt the butter with the garlic." }
        ]
      }
    });
  });

  it("drops an amount its quote does not state and lists the gap", () => {
    const { candidate, rejections } = buildVideoRecipeCandidate(
      payload({
        ingredients: [
          ...payload().ingredients,
          {
            item: "parmesan",
            amount: "1/4 cup",
            section: null,
            source: "speech",
            quote: "and some parmesan on top"
          }
        ]
      }),
      options
    );

    expect(candidate?.recipe.ingredients?.at(-1)).toEqual({ text: "parmesan", section: null });
    expect(candidate?.warnings).toEqual(["The video doesn't give amounts for: parmesan."]);
    expect(rejections).toEqual([
      'amount not in its quote: 1/4 cup parmesan <- "and some parmesan on top"'
    ]);
  });

  it("drops an ingredient its quote does not name", () => {
    const { candidate, rejections } = buildVideoRecipeCandidate(
      payload({
        ingredients: [
          ...payload().ingredients,
          {
            item: "heavy cream",
            amount: "1 cup",
            section: null,
            source: "speech",
            quote: "now pour in your pasta water"
          }
        ]
      }),
      options
    );

    expect(candidate?.recipe.ingredients).toHaveLength(3);
    expect(rejections[0]).toMatch(/^ingredient not in its quote: heavy cream/u);
  });

  it("never keeps an amount for an ingredient that is only shown", () => {
    const { candidate } = buildVideoRecipeCandidate(
      payload({
        ingredients: [
          ...payload().ingredients,
          {
            item: "parsley",
            amount: "2 tbsp",
            section: null,
            source: "visual",
            quote: "chopped parsley sprinkled on top"
          }
        ]
      }),
      options
    );

    expect(candidate?.recipe.ingredients?.at(-1)?.text).toBe("parsley");
  });

  it("checks caption quotes against the caption itself", () => {
    const { candidate, rejections } = buildVideoRecipeCandidate(
      payload({
        ingredients: [
          ...payload().ingredients,
          {
            item: "chili flakes",
            amount: null,
            section: null,
            source: "caption",
            quote: "chili flakes"
          }
        ]
      }),
      options
    );

    expect(candidate?.recipe.ingredients).toHaveLength(3);
    expect(rejections[0]).toMatch(/^ingredient not in its quote: chili flakes/u);
  });

  it("reports no recipe for a video that is not one", () => {
    expect(
      buildVideoRecipeCandidate(
        payload({ recipeInVideo: false, notRecipeReason: "A restaurant review." }),
        options
      )
    ).toEqual({ candidate: null, rejections: ["not a recipe: A restaurant review."] });
  });

  it("reports no recipe when too little survives the checks", () => {
    const { candidate } = buildVideoRecipeCandidate(
      payload({ ingredients: payload().ingredients.slice(0, 1) }),
      options
    );

    expect(candidate).toBeNull();
    expect(buildVideoRecipeCandidate(payload({ steps: [] }), options).candidate).toBeNull();
  });

  it("falls back to the video's title, then the given title", () => {
    expect(
      buildVideoRecipeCandidate(payload({ title: null }), options).candidate?.recipe.title
    ).toBe("TikTok recipe from Cook Creator");
    expect(
      buildVideoRecipeCandidate(payload({ title: null }), {
        ...options,
        context: { ...context, title: "Best noodles ever" }
      }).candidate?.recipe.title
    ).toBe("Best noodles ever");
  });
});
