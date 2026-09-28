import { describe, expect, it } from "vitest";

import { looksLikeRecipeText, readRecipeTextSignals } from "./recipe-text-signals";

describe("looksLikeRecipeText", () => {
  it("accepts captions and notes with quantities", () => {
    expect(
      looksLikeRecipeText("Easy chili: 1 lb ground beef, 1 can beans, 2 tbsp chili powder 🌶️")
    ).toBe(true);
    expect(looksLikeRecipeText("Zutaten: 250 g Mehl, 2 EL Zucker. Alles verrühren.")).toBe(true);
    expect(looksLikeRecipeText("Ingredients\n½ cup oats\nSoak overnight and stir in honey.")).toBe(
      true
    );
  });

  it("accepts method-heavy text with a quantity and cooking verbs", () => {
    expect(
      looksLikeRecipeText("Preheat the oven. Mix the butter with 2 eggs, then bake until golden.")
    ).toBe(true);
  });

  it("rejects captions without recipe content", () => {
    expect(looksLikeRecipeText("best pasta of my life 😍 #foodtok #fyp")).toBe(false);
    expect(looksLikeRecipeText("Thanks for dinner last night, it was lovely to see you!")).toBe(
      false
    );
    expect(looksLikeRecipeText("Recipe in my bio!! Follow for more")).toBe(false);
  });

  it("does not read units inside words", () => {
    expect(readRecipeTextSignals("I have 3 large dogs and 2 goats").quantities).toBe(0);
  });
});
