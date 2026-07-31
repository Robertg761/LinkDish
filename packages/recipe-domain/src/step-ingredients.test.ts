import { describe, expect, it } from "vitest";

import { matchStepIngredients, SAMPLE_RECIPES } from "./index";

const recipeById = (id: string) => {
  const sample = SAMPLE_RECIPES.find((candidate) => candidate.id === id);

  if (!sample) {
    throw new Error(`Missing sample recipe ${id}`);
  }

  return sample.recipe;
};

describe("matchStepIngredients", () => {
  it("matches the skillet sample conservatively", () => {
    const recipe = recipeById("starter-ginger-sesame-chicken-rice-skillet");
    const matches = recipe.steps.map((step) => matchStepIngredients(step.text, recipe.ingredients));

    expect(matches).toEqual([[0, 1, 2, 3, 4], [5, 6], [5], [7, 8], [], [9, 10, 11]]);
  });

  it("matches the oat bar sample without treating prepared mixtures as single ingredients", () => {
    const recipe = recipeById("starter-brown-butter-berry-oat-bars");
    const matches = recipe.steps.map((step) => matchStepIngredients(step.text, recipe.ingredients));

    expect(matches).toEqual([[], [0], [0, 1, 2, 3, 4, 5], [], [6, 7, 8, 9], [10], []]);
  });

  it("matches the cucumber pita sample", () => {
    const recipe = recipeById("starter-crisp-cucumber-chickpea-pitas");
    const matches = recipe.steps.map((step) => matchStepIngredients(step.text, recipe.ingredients));

    expect(matches).toEqual([
      [4, 5, 6, 7],
      [0, 1, 2, 3],
      [8, 9]
    ]);
  });

  it("does not match generic or adjective-only ingredient words", () => {
    expect(
      matchStepIngredients("Season with salt.", [
        "2 tablespoons salted butter",
        "1 teaspoon smoked paprika",
        "1 cup chopped parsley"
      ])
    ).toEqual([]);

    expect(
      matchStepIngredients("Pour in the sauce and simmer.", ["3 tablespoons low-sodium soy sauce"])
    ).toEqual([]);
    expect(
      matchStepIngredients("Sprinkle with sesame oil.", ["1 teaspoon toasted sesame seeds"])
    ).toEqual([]);
    expect(
      matchStepIngredients("Add sugar if needed.", [
        "2 tablespoons granulated sugar",
        "1 tablespoon coarse sugar"
      ])
    ).toEqual([]);
  });

  it("ignores bracketed and parenthesized preparation notes", () => {
    expect(
      matchStepIngredients("Add the tomatoes and simmer.", [
        "1 can tomatoes [drained chicken]",
        "1 cup stock (with spinach)"
      ])
    ).toEqual([0]);
  });
});
