import { describe, expect, it } from "vitest";

import { buildHtmlSourceDocument } from "../../html/parsed-html-document";

import { extractRecipeWebpage } from "./extract-recipe-webpage";
import { readJsonLdInstructionLines, readJsonLdKeywords, readJsonLdVideoUrl } from "./json-ld";

const pageWithJsonLd = (recipe: unknown, head = "", body = "<h1>Page heading</h1>") =>
  buildHtmlSourceDocument({
    url: "https://fixtures.linkdish.test/structured",
    finalUrl: "https://fixtures.linkdish.test/structured",
    html: `<html><head>${head}<script type="application/ld+json">${JSON.stringify(
      recipe
    )}</script></head><body>${body}</body></html>`,
    contentType: "text/html",
    blockedSignals: [],
    statusCode: 200
  });

const baseRecipe = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Lentil Soup",
  recipeIngredient: ["1 cup red lentils", "1 onion, diced", "4 cups stock"],
  recipeInstructions: ["Soften the onion.", "Add lentils and stock and simmer for 25 minutes."]
};

describe("JSON-LD shapes that used to crash or lose data", () => {
  it("splits a recipeIngredient string into lines instead of throwing", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd({
        ...baseRecipe,
        recipeIngredient: "1 cup red lentils\n1 onion, diced<br>4 cups stock"
      })
    );

    expect(candidate?.recipe.ingredients).toEqual([
      { text: "1 cup red lentils" },
      { text: "1 onion, diced" },
      { text: "4 cups stock" }
    ]);
  });

  it("splits a recipeInstructions HTML string into steps", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd({
        ...baseRecipe,
        recipeInstructions:
          "<ol><li>Soften the onion.</li><li>Add the lentils &amp; stock.</li></ol>"
      })
    );

    expect(candidate?.recipe.steps).toEqual([
      { index: 1, text: "Soften the onion." },
      { index: 2, text: "Add the lentils & stock." }
    ]);
  });

  it("strips markup inside JSON-LD strings and decodes entities", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd({
        ...baseRecipe,
        name: "Grandma&rsquo;s <em>Lentil</em> Soup",
        recipeIngredient: ["1 cup <strong>red</strong> lentils", "&frac12; tsp salt"],
        recipeInstructions: [
          { "@type": "HowToStep", text: "<p>Mix &amp; bake at 350&deg;F.</p>" },
          { "@type": "HowToStep", text: "&lt;p&gt;Serve warm.&lt;/p&gt;" }
        ]
      })
    );

    expect(candidate?.recipe.title).toBe("Grandma’s Lentil Soup");
    expect(candidate?.recipe.ingredients).toEqual([
      { text: "1 cup red lentils" },
      { text: "½ tsp salt" }
    ]);
    expect(candidate?.recipe.steps).toEqual([
      { index: 1, text: "Mix & bake at 350°F." },
      { index: 2, text: "Serve warm." }
    ]);
  });

  it("keeps short structured ingredients and steps that heuristics used to drop", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd({
        ...baseRecipe,
        recipeIngredient: ["2 cups greens", "Salt", "Pepper"],
        recipeInstructions: "Toss."
      })
    );

    expect(candidate?.recipe.ingredients).toEqual([
      { text: "2 cups greens" },
      { text: "Salt" },
      { text: "Pepper" }
    ]);
    expect(candidate?.recipe.steps).toEqual([{ index: 1, text: "Toss." }]);
  });

  it("tolerates null, numeric and nested instruction entries", () => {
    expect(
      readJsonLdInstructionLines([
        null,
        42,
        { "@type": "HowToStep", name: "Only a name." },
        {
          "@type": "HowToStep",
          itemListElement: [{ "@type": "HowToDirection", text: "A direction." }]
        },
        { "@type": "HowToSection", name: "Sauce", itemListElement: ["Heat the oil."] }
      ])
    ).toEqual(["Only a name.", "A direction.", "Heat the oil."]);
    expect(readJsonLdInstructionLines({ "@type": "HowToStep", text: "Single step." })).toEqual([
      "Single step."
    ]);
  });

  it("finds a Recipe nested under mainEntity and typed with a schema prefix", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd({
        "@type": "WebPage",
        mainEntity: { ...baseRecipe, "@type": "http://schema.org/Recipe" }
      })
    );

    expect(candidate?.recipe.title).toBe("Lentil Soup");
    expect(candidate?.recipe.ingredients).toHaveLength(3);
  });

  it("parses totalTime (including forms the old parser missed) into totalTimeMinutes", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd({ ...baseRecipe, prepTime: "PT0.5H", totalTime: "P0DT1H15M" })
    );

    expect(candidate?.recipe.prepTimeMinutes).toBe(30);
    expect(candidate?.recipe.cookTimeMinutes).toBeNull();
    expect(candidate?.recipe.totalTimeMinutes).toBe(75);
    expect(candidate?.signals.timesFromStructuredMetadata).toBe(true);
  });
});

describe("microdata times", () => {
  it("keeps totalTime out of prep and cook", () => {
    const candidate = extractRecipeWebpage(
      buildHtmlSourceDocument({
        url: "https://fixtures.linkdish.test/microdata-total",
        finalUrl: "https://fixtures.linkdish.test/microdata-total",
        html: `<html><body><article itemscope itemtype="https://schema.org/Recipe">
          <h1 itemprop="name">Overnight Oats</h1>
          <time itemprop="totalTime" datetime="PT8H5M">8 hours</time>
          <ul><li itemprop="recipeIngredient">1 cup oats</li><li itemprop="recipeIngredient">1 cup milk</li></ul>
          <p itemprop="recipeInstructions">Stir together and chill overnight.</p>
        </article></body></html>`,
        contentType: "text/html",
        blockedSignals: [],
        statusCode: 200
      })
    );

    expect(candidate?.recipe.prepTimeMinutes).toBeNull();
    expect(candidate?.recipe.cookTimeMinutes).toBeNull();
    expect(candidate?.recipe.totalTimeMinutes).toBe(485);
    expect(candidate?.fieldProvenance.cookTimeMinutes).toBeNull();
  });
});

describe("recipe metadata", () => {
  it("reads description, author, site, cuisine, category, keywords and video", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd(
        {
          ...baseRecipe,
          description: "<p>A cosy weeknight soup.</p>",
          author: [
            { "@type": "Person", name: "Ada Cook" },
            { "@type": "Person", name: "https://example.com/about" },
            "Ben Baker"
          ],
          recipeCuisine: ["Indian", "indian"],
          recipeCategory: "Soup",
          keywords: "lentils, soup, Soup,  vegan ",
          video: {
            "@type": "VideoObject",
            contentUrl: "javascript:alert(1)",
            embedUrl: "https://www.youtube.com/embed/abc123def45"
          }
        },
        '<meta property="og:site_name" content="Fixture Kitchen">'
      )
    );

    expect(candidate?.recipe).toMatchObject({
      description: "A cosy weeknight soup.",
      author: "Ada Cook, Ben Baker",
      siteName: "Fixture Kitchen",
      cuisine: "Indian",
      category: "Soup",
      keywords: ["lentils", "soup", "vegan"],
      videoUrl: "https://www.youtube.com/embed/abc123def45"
    });
  });

  it("falls back to page metadata and leaves unknown fields off the recipe", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd(baseRecipe, '<meta name="description" content="Meta description.">')
    );

    expect(candidate?.recipe.description).toBe("Meta description.");
    expect(candidate?.recipe).not.toHaveProperty("author");
    expect(candidate?.recipe).not.toHaveProperty("keywords");
    expect(candidate?.recipe).not.toHaveProperty("videoUrl");
    expect(candidate?.recipe).not.toHaveProperty("totalTimeMinutes");
  });

  it("caps keywords at 30 and ignores non-http video urls", () => {
    const keywords = Array.from({ length: 40 }, (_, index) => `tag${index}`);

    expect(readJsonLdKeywords(keywords.join(","))).toHaveLength(30);
    expect(readJsonLdKeywords([" a ", "A", 3, "b;c"])).toEqual(["a", "b", "c"]);
    expect(readJsonLdVideoUrl([{ contentUrl: "data:video/mp4;base64,AAAA" }])).toBeNull();
    expect(readJsonLdVideoUrl({ url: "https://cdn.example.com/soup.mp4" })).toBe(
      "https://cdn.example.com/soup.mp4"
    );
  });
});

describe("ingredient groups", () => {
  const wprmGroups = `
    <div class="wprm-recipe-ingredient-group">
      <h3 class="wprm-recipe-group-name">For the cake:</h3>
      <ul><li class="wprm-recipe-ingredient">2 cups flour</li><li class="wprm-recipe-ingredient">1 cup sugar</li></ul>
    </div>
    <div class="wprm-recipe-ingredient-group">
      <h3 class="wprm-recipe-group-name">For the frosting</h3>
      <ul><li class="wprm-recipe-ingredient">1 cup sugar</li></ul>
    </div>`;

  it("labels structured ingredients with WP Recipe Maker group names", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd(
        { ...baseRecipe, recipeIngredient: ["2 cups flour", "1 cup sugar", "1 cup sugar"] },
        "",
        wprmGroups
      )
    );

    expect(candidate?.recipe.ingredients).toEqual([
      { text: "2 cups flour", section: "For the cake" },
      { text: "1 cup sugar", section: "For the cake" },
      { text: "1 cup sugar", section: "For the frosting" }
    ]);
  });

  it("labels Tasty Recipes groups", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd(
        { ...baseRecipe, recipeIngredient: ["1 lb pasta", "2 cups basil", "1/2 cup oil"] },
        "",
        `<div class="tasty-recipes-ingredients-body">
          <ul><li>1 lb pasta</li></ul>
          <h4>Pesto</h4>
          <ul><li>2 cups basil</li><li>1/2 cup oil</li></ul>
        </div>`
      )
    );

    expect(candidate?.recipe.ingredients).toEqual([
      { text: "1 lb pasta" },
      { text: "2 cups basil", section: "Pesto" },
      { text: "1/2 cup oil", section: "Pesto" }
    ]);
  });

  it("leaves the list flat when the page groups do not add up", () => {
    const candidate = extractRecipeWebpage(
      pageWithJsonLd(
        { ...baseRecipe, recipeIngredient: ["2 cups flour", "1 cup sugar"] },
        "",
        wprmGroups
      )
    );

    expect(candidate?.recipe.ingredients).toEqual([
      { text: "2 cups flour" },
      { text: "1 cup sugar" }
    ]);
  });
});
