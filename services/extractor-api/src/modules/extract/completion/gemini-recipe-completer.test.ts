import { describe, expect, it, vi } from "vitest";

import {
  AI_FILLED_NOTE,
  applyRecipeCompletion,
  buildRecipeCompletionPrompt,
  createGeminiRecipeCompleter,
  hasUsableAmount,
  keepsIngredientIdentity,
  type RecipeCompletionPayload
} from "./gemini-recipe-completer";

import type { Recipe } from "../../../../../../packages/recipe-domain/src/index.js";

const now = new Date("2026-11-03T12:00:00.000Z");

/* What the video reader imports from a silent soup montage. */
const montageRecipe = (): Recipe => ({
  title: "Broccoli Cheddar Soup",
  sourceUrl: "https://www.facebook.com/61594398413545/videos/soup/28203918889307565/",
  sourceType: "social",
  image: null,
  ingredients: [
    { text: "butter", section: null },
    { text: "carrots, shredded", section: null },
    { text: "broccoli", section: null },
    { text: "milk", section: null },
    { text: "cheddar cheese", section: null }
  ],
  steps: [
    { index: 1, text: "Soften the carrots in butter." },
    { index: 2, text: "Stir in the broccoli, then the milk." },
    { index: 3, text: "Melt in the cheddar." }
  ],
  servings: null,
  prepTimeMinutes: null,
  cookTimeMinutes: null,
  nutrition: null,
  confidence: {
    score: 0.6,
    summary: "Read the recipe from the video's speech, on-screen text and caption.",
    missingFields: ["servings", "prepTimeMinutes", "cookTimeMinutes"],
    notes: [
      "The video doesn't give amounts for: butter, carrots, shredded, broccoli, milk, cheddar cheese.",
      "The source didn't list servings or a prep time."
    ],
    fieldProvenance: {
      title: "llm",
      ingredients: "llm",
      steps: "llm",
      servings: null,
      prepTimeMinutes: null,
      cookTimeMinutes: null,
      nutrition: null
    }
  },
  siteName: "Facebook",
  videoUrl: "https://www.facebook.com/61594398413545/videos/soup/28203918889307565/",
  completion: {
    status: "missing_amounts",
    ingredients: ["butter", "carrots, shredded", "broccoli", "milk", "cheddar cheese"]
  }
});

const answer = (overrides: Partial<RecipeCompletionPayload> = {}): RecipeCompletionPayload => ({
  ingredients: [
    { text: "4 tbsp butter", section: null, added: false },
    { text: "1/2 cup onion, diced", section: null, added: true },
    { text: "1 cup carrots, shredded", section: null, added: false },
    { text: "3 cups broccoli florets", section: null, added: false },
    { text: "2 cups chicken broth", section: null, added: true },
    { text: "2 cups milk", section: null, added: false },
    { text: "8 oz sharp cheddar cheese, shredded", section: null, added: false }
  ],
  steps: [
    {
      text: "Melt the butter in a large pot over medium heat and soften the onion and carrots, 5 minutes."
    },
    { text: "Stir in the broccoli, broth and milk and simmer until tender, 15 minutes." },
    { text: "Take off the heat and stir in the cheddar until melted." }
  ],
  servings: "4",
  prepTimeMinutes: 10,
  cookTimeMinutes: 25,
  ...overrides
});

describe("applyRecipeCompletion", () => {
  it("fills the amounts, keeps the creator's ingredients and labels the recipe AI-filled", () => {
    const completed = applyRecipeCompletion(montageRecipe(), answer(), now);

    expect(completed).toMatchObject({
      title: "Broccoli Cheddar Soup",
      servings: "4",
      prepTimeMinutes: 10,
      cookTimeMinutes: 25,
      completion: {
        status: "ai_filled",
        ingredients: ["butter", "carrots, shredded", "broccoli", "milk", "cheddar cheese"],
        filledAt: "2026-11-03T12:00:00.000Z"
      },
      videoUrl: montageRecipe().videoUrl
    });
    expect(completed?.ingredients.map((ingredient) => ingredient.text)).toEqual(
      answer().ingredients.map((ingredient) => ingredient.text)
    );
    expect(completed?.steps.map((step) => step.index)).toEqual([1, 2, 3]);
    expect(completed?.confidence.notes).toEqual([
      "The source didn't list servings or a prep time.",
      AI_FILLED_NOTE
    ]);
    expect(completed?.confidence.missingFields).toEqual([]);
    expect(completed?.confidence.fieldProvenance).toMatchObject({
      servings: "llm",
      prepTimeMinutes: "llm",
      cookTimeMinutes: "llm"
    });
  });

  it("keeps servings and times the source already gave", () => {
    const recipe = { ...montageRecipe(), servings: "6", cookTimeMinutes: 40 };
    const completed = applyRecipeCompletion(recipe, answer(), now);

    expect(completed).toMatchObject({ servings: "6", cookTimeMinutes: 40, prepTimeMinutes: 10 });
  });

  it("refuses an answer that drops, swaps or reorders one of the creator's ingredients", () => {
    const [butter, onion, carrots, broccoli, broth, milk, cheddar] = answer().ingredients;

    for (const ingredients of [
      [butter!, onion!, carrots!, broccoli!, broth!, milk!],
      [butter!, carrots!, broccoli!, milk!, { ...cheddar!, text: "8 oz gruyere" }],
      [butter!, broccoli!, carrots!, milk!, cheddar!]
    ]) {
      expect(applyRecipeCompletion(montageRecipe(), answer({ ingredients }), now)).toBeNull();
    }
  });

  it("keeps an ingredient whose amount came from the source exactly as the source gave it", () => {
    const recipe: Recipe = {
      ...montageRecipe(),
      ingredients: [
        { text: "2 cups flour", section: null },
        { text: "butter", section: null }
      ],
      completion: { status: "missing_amounts", ingredients: ["butter"] }
    };
    const completed = applyRecipeCompletion(
      recipe,
      answer({
        ingredients: [
          { text: "8 cups flour", section: null, added: false },
          { text: "4 tbsp butter, softened", section: null, added: false },
          { text: "1 tsp salt", section: null, added: true }
        ]
      }),
      now
    );

    expect(completed?.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "2 cups flour",
      "4 tbsp butter, softened",
      "1 tsp salt"
    ]);
    expect(completed?.completion?.ingredients).toEqual(["butter"]);
  });

  it("refuses an answer that leaves a missing amount missing", () => {
    const unfilled = answer().ingredients.map((ingredient) =>
      ingredient.text === "8 oz sharp cheddar cheese, shredded"
        ? { ...ingredient, text: "cheddar cheese" }
        : ingredient
    );

    expect(
      applyRecipeCompletion(montageRecipe(), answer({ ingredients: unfilled }), now)
    ).toBeNull();
  });

  it("still fills an ingredient the person edited since the import", () => {
    const recipe: Recipe = {
      ...montageRecipe(),
      ingredients: [
        { text: "2 cups milk", section: null },
        { text: "broccoli florets", section: null }
      ],
      completion: { status: "missing_amounts", ingredients: ["broccoli"] }
    };
    const withAnswer = (text: string) =>
      applyRecipeCompletion(
        recipe,
        answer({
          ingredients: [
            { text: "2 cups milk", section: null, added: false },
            { text, section: null, added: false }
          ]
        }),
        now
      );

    expect(buildRecipeCompletionPrompt(recipe)).toContain('"missingAmounts":["broccoli florets"]');
    expect(withAnswer("broccoli florets")).toBeNull();
    expect(withAnswer("3 cups broccoli florets")?.ingredients[1]?.text).toBe(
      "3 cups broccoli florets"
    );
  });

  it("refuses an answer that is not a valid recipe", () => {
    expect(
      applyRecipeCompletion(montageRecipe(), answer({ steps: [{ text: "   " }] }), now)
    ).toBeNull();
  });
});

describe("hasUsableAmount", () => {
  it("accepts quantities and measures without a number", () => {
    for (const text of [
      "2 cups milk",
      "½ tsp salt",
      "1/2 lb ground beef",
      "a pinch of nutmeg",
      "one can black beans",
      "salt and pepper, to taste",
      "handful of basil"
    ]) {
      expect(hasUsableAmount(text)).toBe(true);
    }
  });

  it("refuses a bare ingredient", () => {
    for (const text of ["broccoli", "cheddar cheese", "almonds, sliced"]) {
      expect(hasUsableAmount(text)).toBe(false);
    }
  });
});

describe("keepsIngredientIdentity", () => {
  it("accepts the creator's ingredient with an amount, even reworded or prepared", () => {
    expect(keepsIngredientIdentity("cheddar cheese", "8 oz sharp cheddar cheese, shredded")).toBe(
      true
    );
    expect(keepsIngredientIdentity("carrots, shredded", "1 cup grated carrots")).toBe(true);
    expect(keepsIngredientIdentity("tomatoes", "2 large tomato, diced")).toBe(true);
  });

  it("refuses a different ingredient that only shares a word", () => {
    expect(keepsIngredientIdentity("cheddar cheese", "8 oz cream cheese")).toBe(false);
    expect(keepsIngredientIdentity("almond milk", "2 cups whole milk")).toBe(false);
    expect(keepsIngredientIdentity("chicken broth", "2 cups vegetable broth")).toBe(false);
  });
});

describe("buildRecipeCompletionPrompt", () => {
  it("sends the recipe and asks to keep the creator's ingredients and steps", () => {
    const prompt = buildRecipeCompletionPrompt(montageRecipe());

    expect(prompt).toContain("Keep every ingredient in the list, in the same order");
    expect(prompt).toContain('"title":"Broccoli Cheddar Soup"');
    expect(prompt).toContain('"steps":["Soften the carrots in butter."');
    expect(prompt).toContain(
      '"missingAmounts":["butter","carrots, shredded","broccoli","milk","cheddar cheese"]'
    );
  });
});

describe("createGeminiRecipeCompleter", () => {
  const geminiResponse = (payload: unknown, status = 200) =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
      { status, headers: { "content-type": "application/json" } }
    );

  it("is unavailable without an API key", async () => {
    const completer = createGeminiRecipeCompleter({
      apiKey: undefined,
      fetchImplementation: fetch
    });

    expect(completer.available).toBe(false);
    await expect(completer.complete(montageRecipe())).resolves.toBeNull();
  });

  it("asks Gemini for structured JSON and applies its answer", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(geminiResponse(answer()))
    );
    const completer = createGeminiRecipeCompleter({
      apiKey: "test-key",
      model: "gemini-test",
      fetchImplementation,
      now: () => now
    });

    const completed = await completer.complete(montageRecipe());

    expect(completed?.completion?.status).toBe("ai_filled");

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
    );
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      generationConfig: { responseMimeType: "application/json" }
    });
  });

  it("answers null for an HTTP error, malformed JSON or an unusable answer", async () => {
    for (const response of [
      geminiResponse(answer(), 500),
      new Response("{not json", { status: 200 }),
      geminiResponse({ ingredients: [] }),
      geminiResponse(answer({ ingredients: answer().ingredients.slice(0, 2) }))
    ]) {
      const completer = createGeminiRecipeCompleter({
        apiKey: "test-key",
        fetchImplementation: () => Promise.resolve(response)
      });

      await expect(completer.complete(montageRecipe())).resolves.toBeNull();
    }
  });
});
