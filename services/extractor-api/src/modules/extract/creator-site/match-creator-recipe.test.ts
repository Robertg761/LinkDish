import { describe, expect, it } from "vitest";

import {
  pickMatchingRecipe,
  readCreatorSiteDomain,
  readDishQuery,
  scoreCandidateTitle
} from "./match-creator-recipe";

import type { Recipe } from "../../../../../../packages/recipe-domain/src/index.js";

const recipe = (
  title: string,
  description: string,
  ingredients: string[],
  steps: string[]
): Recipe =>
  ({
    title,
    description,
    ingredients: ingredients.map((text) => ({ text, section: null })),
    steps: steps.map((text, index) => ({ index: index + 1, text }))
  }) as unknown as Recipe;

/* Trimmed from fedbysab.com: two quesadilla rings whose titles match the caption equally well. */
const buffaloRing = recipe(
  "Buffalo Chicken Blooming Quesadilla",
  "Buffalo Chicken Blooming Quesadilla ring is a unique appetizer! Flour tortillas are rolled with buffalo chicken filling and shaped into a pull apart ring.",
  ["12 flour tortillas", "4 cups cooked chicken", "8 ounces cream cheese", "1/4 cup Buffalo sauce"],
  ["Mix the chicken, cream cheese and buffalo sauce.", "Arrange the cones in a ring and bake."]
);
const tacoRing = recipe(
  "Blooming Chicken Quesadilla Ring",
  "Blooming Chicken Quesadilla Ring is a unique appetizer! Flour tortillas are rolled with chicken quesadilla filling and shaped into a pull apart ring.",
  ["12 medium flour tortillas", "3 cups cooked chicken", "1 1/2 tbsp taco seasoning"],
  ["Mix the chicken with the taco seasoning.", "Arrange the cones in a ring and bake."]
);
const pastaSalad = recipe(
  "Buffalo Chicken Pasta Salad",
  "A creamy buffalo chicken pasta salad.",
  ["1 lb pasta", "2 cups chicken", "1/3 cup buffalo sauce"],
  ["Boil the pasta.", "Toss everything together."]
);

const caption = "🚨 Recipe in Comments ⭐️ Pull Apart Buffalo Chicken Quesadilla Ring 🧀 🌶️";

describe("readCreatorSiteDomain", () => {
  it("reads a page named after its site", () => {
    expect(readCreatorSiteDomain("fedbysab.com")).toBe("fedbysab.com");
    expect(readCreatorSiteDomain(" www.Cook.Example.co.uk/ ")).toBe("cook.example.co.uk");
    expect(readCreatorSiteDomain("https://cook.example")).toBe("cook.example");
  });

  it("ignores names that are not a domain, and platform or link-hub domains", () => {
    for (const name of [
      null,
      "Fed by Sab",
      "Mrs. Smith",
      "Dinner with Dana",
      "facebook.com",
      "linktr.ee",
      "cook.example/recipes",
      "localhost"
    ]) {
      expect(readCreatorSiteDomain(name)).toBeNull();
    }
  });
});

describe("readDishQuery", () => {
  it("reads the dish out of a 'recipe in comments' caption", () => {
    expect(readDishQuery(caption)).toBe("Pull Apart Buffalo Chicken Quesadilla Ring");
  });

  it("skips filler, hashtags, mentions and links", () => {
    expect(
      readDishQuery("Full recipe below! 👇\nCreamy Tuscan Salmon #dinner @cook https://x.example")
    ).toBe("Creamy Tuscan Salmon");
    expect(readDishQuery("Comment RECIPE and I'll send it 💌 | Garlic Butter Steak Bites")).toBe(
      "Garlic Butter Steak Bites"
    );
    expect(readDishQuery("Recipe in the first comment ⬇️ — Lemon Orzo Soup")).toBe(
      "Lemon Orzo Soup"
    );
  });

  it("is null when nothing names a dish", () => {
    expect(readDishQuery("🚨 Recipe in Comments 🚨")).toBeNull();
    expect(readDishQuery("so good 😍 #dinner")).toBeNull();
    expect(readDishQuery("")).toBeNull();
  });
});

describe("scoreCandidateTitle", () => {
  const query = "Pull Apart Buffalo Chicken Quesadilla Ring";

  it("keeps titles that share at least two words making up half the title", () => {
    expect(scoreCandidateTitle(query, "Buffalo Chicken Blooming Quesadilla")).toBe(3);
    expect(scoreCandidateTitle(query, "Blooming Chicken Quesadilla Ring")).toBe(3);
    expect(scoreCandidateTitle(query, "Buffalo Chicken Pasta Salad")).toBe(2);
  });

  it("drops titles that only share a word, or are mostly about something else", () => {
    expect(scoreCandidateTitle(query, "Pizza Dip Ring")).toBe(0);
    expect(scoreCandidateTitle(query, "Chicken Parmesan Meatball Subs on a Stick")).toBe(0);
    expect(scoreCandidateTitle(query, "Chicken and Rice Soup with Lemon Garlic Herbs")).toBe(0);
  });
});

describe("pickMatchingRecipe", () => {
  const query = "Pull Apart Buffalo Chicken Quesadilla Ring";

  it("picks the recipe whose whole text matches the caption, not just its title", () => {
    expect(pickMatchingRecipe(query, [tacoRing, buffaloRing, pastaSalad])).toBe(1);
    expect(pickMatchingRecipe(query, [pastaSalad, null, buffaloRing])).toBe(2);
  });

  it("refuses a tie", () => {
    expect(pickMatchingRecipe(query, [buffaloRing, { ...buffaloRing }])).toBeNull();
  });

  it("refuses the creator's other version of the dish, even when it is the only result", () => {
    expect(pickMatchingRecipe(query, [tacoRing])).toBeNull();
    expect(pickMatchingRecipe(query, [tacoRing, pastaSalad])).toBeNull();
  });

  it("ignores caption labels a recipe page does not repeat", () => {
    expect(pickMatchingRecipe(`Viral Copycat ${query}`, [tacoRing, buffaloRing])).toBe(1);
  });

  it("refuses a weak match", () => {
    expect(pickMatchingRecipe(query, [pastaSalad])).toBeNull();
    expect(pickMatchingRecipe(query, [null])).toBeNull();
    expect(pickMatchingRecipe(query, [])).toBeNull();
  });
});
