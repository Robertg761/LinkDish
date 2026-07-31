import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractRecipeWebpage } from "./extract-recipe-webpage";

const loadFixture = (fileName: string) =>
  readFileSync(new URL(`../../__fixtures__/${fileName}`, import.meta.url), "utf8");

describe("extractRecipeWebpage", () => {
  it("extracts recipe data from JSON-LD", () => {
    const candidate = extractRecipeWebpage({
      kind: "html",
      url: "https://fixtures.linkdish.test/recipe-jsonld",
      finalUrl: "https://fixtures.linkdish.test/recipe-jsonld",
      html: loadFixture("recipe-jsonld.html"),
      contentType: "text/html",
      title: "Recipe JSON-LD Fixture",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate?.strategy).toBe("recipe-schema");
    expect(candidate?.recipe.ingredients).toHaveLength(4);
    expect(candidate?.recipe.steps).toHaveLength(3);
    expect(candidate?.recipe.image).toEqual({
      height: 900,
      source: "jsonld",
      url: "https://cdn.example.test/images/tomato-pasta.jpg",
      width: 1200
    });
    expect(candidate?.recipe.nutrition?.calories).toBe("480 kcal");
  });

  it("extracts recipe data from microdata", () => {
    const candidate = extractRecipeWebpage({
      kind: "html",
      url: "https://fixtures.linkdish.test/recipe-microdata",
      finalUrl: "https://fixtures.linkdish.test/recipe-microdata",
      html: loadFixture("recipe-microdata.html"),
      contentType: "text/html",
      title: "Recipe Microdata Fixture",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate?.recipe.title).toBe("Creamy Mushroom Orzo");
    expect(candidate?.recipe.servings).toBe("2 servings");
  });

  it("falls back to heuristic extraction when schema is malformed", () => {
    const candidate = extractRecipeWebpage({
      kind: "html",
      url: "https://fixtures.linkdish.test/article-weak",
      finalUrl: "https://fixtures.linkdish.test/article-weak",
      html: loadFixture("article-weak.html"),
      contentType: "text/html",
      title: "Article Weak Fixture",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate?.signals.requiredFieldsInferred).toBe(true);
  });

  it("extracts visible nutrition text when schema nutrition is missing", () => {
    const candidate = extractRecipeWebpage({
      kind: "html",
      url: "https://fixtures.linkdish.test/recipe-visible-nutrition",
      finalUrl: "https://fixtures.linkdish.test/recipe-visible-nutrition",
      html: loadFixture("recipe-visible-nutrition.html"),
      contentType: "text/html",
      title: "Recipe Nutrition Fixture",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate?.recipe.nutrition?.calories).toBe("280 calories");
    expect(candidate?.recipe.nutrition?.sodium).toBe("480 mg");
  });

  it("sanitizes malformed ingredient note punctuation from json-ld", () => {
    const candidate = extractRecipeWebpage({
      kind: "html",
      url: "https://fixtures.linkdish.test/recipe-jsonld-malformed-notes",
      finalUrl: "https://fixtures.linkdish.test/recipe-jsonld-malformed-notes",
      html: `
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Recipe",
                "name": "Butter Chicken",
                "recipeIngredient": [
                  "2 tsp garam masala ((Note 1))",
                  "1/2 cup plain yoghurt (, full fat)",
                  "1 (14-ounce) can crushed tomatoes"
                ],
                "recipeInstructions": [
                  "Mix everything together.",
                  "Cook until done."
                ]
              }
            </script>
          </head>
          <body>
            <h1>Butter Chicken</h1>
          </body>
        </html>
      `,
      contentType: "text/html",
      title: "Butter Chicken",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate?.recipe.ingredients).toEqual([
      { text: "2 tsp garam masala (Note 1)" },
      { text: "1/2 cup plain yoghurt, full fat" },
      { text: "1 (14-ounce) can crushed tomatoes" }
    ]);
  });

  it("preserves nested JSON-LD instruction section steps as separate method steps", () => {
    const candidate = extractRecipeWebpage({
      kind: "html",
      url: "https://fixtures.linkdish.test/recipe-jsonld-sectioned-instructions",
      finalUrl: "https://fixtures.linkdish.test/recipe-jsonld-sectioned-instructions",
      html: `
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Recipe",
                "name": "Sunday Sauce",
                "recipeIngredient": [
                  "2 tbsp olive oil",
                  "1 onion, diced",
                  "1 can tomatoes"
                ],
                "recipeInstructions": [
                  {
                    "@type": "HowToSection",
                    "name": "Sauce",
                    "itemListElement": [
                      { "@type": "HowToStep", "text": "Heat the oil." },
                      { "@type": "HowToStep", "text": "Add the onion and cook until softened." },
                      { "@type": "HowToStep", "text": "Stir in the tomatoes and simmer." }
                    ]
                  }
                ]
              }
            </script>
          </head>
          <body>
            <h1>Sunday Sauce</h1>
          </body>
        </html>
      `,
      contentType: "text/html",
      title: "Sunday Sauce",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate?.recipe.steps).toEqual([
      { index: 1, text: "Heat the oil." },
      { index: 2, text: "Add the onion and cook until softened." },
      { index: 3, text: "Stir in the tomatoes and simmer." }
    ]);
  });
});
