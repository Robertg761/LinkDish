import { describe, expect, it } from "vitest";

import {
  createLinkDishBackup,
  findSchemaOrgRecipe,
  linkdishBackupSchema,
  melaRecipeToRecipe,
  paprikaRecipeToRecipe,
  recipeSchema,
  recipeToJsonLd,
  recipeToMarkdown,
  recipeToPlainText,
  SAMPLE_RECIPES,
  schemaOrgRecipeToRecipe,
  toIsoDuration,
  validateBackup
} from "./index.js";

import type { BackupRecipe, Recipe } from "./index.js";

const skillet = SAMPLE_RECIPES[0].recipe as Recipe;
const bars = SAMPLE_RECIPES[1].recipe as Recipe;

const backupEntry = (
  recipe: Recipe,
  overrides: Partial<BackupRecipe["meta"]> = {}
): BackupRecipe => ({
  id: `saved-${recipe.title.length}`,
  recipe,
  meta: {
    favorite: true,
    tags: ["weeknight"],
    rating: 5,
    notes: "Double the sauce.",
    timesCooked: 3,
    cookLog: [{ cookedAt: "2026-09-20T18:00:00.000Z", rating: 5 }],
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-20T18:30:00.000Z",
    sourceUrl: recipe.sourceUrl,
    ...overrides
  }
});

describe("LinkDish backup", () => {
  const backup = createLinkDishBackup({
    exportedAt: "2026-09-27T10:00:00.000Z",
    app: "web 2.4.0",
    recipes: [backupEntry(skillet), backupEntry(bars, { favorite: false, rating: null })],
    collections: [{ id: "c1", name: "Weeknights", recipeIds: ["saved-34"] }],
    mealPlan: [{ id: "m1", date: "2026-09-28", slot: "dinner", recipeId: "saved-34", servings: 4 }]
  });

  it("creates a backup that satisfies the schema and round-trips through JSON", () => {
    expect(linkdishBackupSchema.safeParse(backup).success).toBe(true);

    const restored = validateBackup(JSON.stringify(backup));

    expect(restored).toEqual({
      ok: true,
      backup: JSON.parse(JSON.stringify(backup)) as unknown,
      warnings: []
    });
  });

  it("skips damaged recipes with a warning instead of failing the restore", () => {
    const damaged = {
      ...backup,
      recipes: [
        backup.recipes[0],
        { recipe: { ...skillet, ingredients: [] }, meta: backup.recipes[0]?.meta },
        { recipe: skillet, meta: { ...backup.recipes[0]?.meta, rating: 9 } }
      ],
      mealPlan: [{ id: "m2", date: "2026-02-30" }]
    };
    const result = validateBackup(damaged);

    expect(result.ok).toBe(true);
    expect(result.ok && result.backup.recipes).toHaveLength(1);
    expect(result.warnings).toEqual([
      'Recipe 2 ("Ginger-Sesame Chicken Rice Skillet") was skipped: recipe.ingredients: Array must contain at least 1 element(s)',
      'Recipe 3 ("Ginger-Sesame Chicken Rice Skillet") was skipped: meta.rating: Number must be less than or equal to 5',
      "Meal plan entry 1 was skipped: date: Expected a YYYY-MM-DD date."
    ]);
  });

  it("rejects files that are not LinkDish backups, newer versions and broken JSON", () => {
    expect(validateBackup("{not json")).toMatchObject({
      ok: false,
      error: "This file is not valid JSON."
    });
    expect(validateBackup({ format: "paprika" })).toMatchObject({
      ok: false,
      error: "This is not a LinkDish backup."
    });
    expect(validateBackup({ ...backup, version: 2 })).toMatchObject({
      ok: false,
      error: "This backup was made by a newer version of LinkDish. Update the app to restore it."
    });
    expect(validateBackup({ ...backup, exportedAt: "yesterday" })).toMatchObject({ ok: false });
    expect(validateBackup(null)).toMatchObject({ ok: false });
  });
});

describe("paprikaRecipeToRecipe", () => {
  const paprika = {
    uid: "9F8E7D6C-1111-2222-3333-444455556666",
    name: "Grandma&rsquo;s Chili",
    ingredients:
      "For the chili:\n2 lb ground beef\n1 onion, diced\n\n1 (28 oz) can crushed tomatoes\nTopping:\n1 cup shredded cheddar",
    directions:
      "1. Brown the beef.\n2. Add the onion and cook 5 minutes.\n\n3. Simmer 1 hour 30 minutes.",
    description: "Cozy.",
    notes: "Better the next day.",
    nutritional_info: "Calories: 450\nProtein: 32 g\nSodium: 900 mg\nMood: great",
    servings: "6 servings",
    prep_time: "15 mins",
    cook_time: "1 hr 45 min",
    total_time: "2 hours",
    source: "Family Cookbook",
    source_url: "",
    image_url: "https://example.com/chili.jpg",
    categories: ["Dinner", "Winter", "dinner"],
    rating: 4,
    on_favorites: 1,
    created: "2021-05-02 12:34:56",
    photo_data: "aGVsbG8="
  };

  it("maps Paprika's fields into a valid recipe and meta", () => {
    const { recipe, meta, warnings } = paprikaRecipeToRecipe(paprika);

    expect(warnings).toEqual([]);
    expect(recipe && recipeSchema.safeParse(recipe).success).toBe(true);
    expect(recipe).toMatchObject({
      title: "Grandma’s Chili",
      sourceType: "unknown",
      image: { url: "https://example.com/chili.jpg", source: "content" },
      ingredients: [
        { text: "2 lb ground beef", section: "For the chili" },
        { text: "1 onion, diced", section: "For the chili" },
        { text: "1 (28 oz) can crushed tomatoes", section: "For the chili" },
        { text: "1 cup shredded cheddar", section: "Topping" }
      ],
      steps: [
        { index: 1, text: "Brown the beef." },
        { index: 2, text: "Add the onion and cook 5 minutes." },
        { index: 3, text: "Simmer 1 hour 30 minutes." }
      ],
      servings: "6 servings",
      prepTimeMinutes: 15,
      cookTimeMinutes: 105,
      totalTimeMinutes: 120,
      description: "Cozy.",
      siteName: "Family Cookbook",
      nutrition: {
        calories: "450",
        protein: "32 g",
        carbohydrates: null,
        fat: null,
        fiber: null,
        sugar: null,
        sodium: "900 mg"
      }
    });
    expect(meta).toEqual({
      sourceUrl: expect.stringMatching(
        /^https:\/\/linkdish\.app\/imports\/paprika\/grandma-s-chili-[0-9a-f]{8}$/u
      ) as unknown,
      sourceUrlSynthetic: true,
      favorite: true,
      rating: 4,
      notes: "Better the next day.",
      tags: ["Dinner", "Winter"],
      createdAt: "2021-05-02T12:34:56.000Z",
      photoDataUrl: "data:image/jpeg;base64,aGVsbG8=",
      externalId: "9F8E7D6C-1111-2222-3333-444455556666"
    });
    expect(recipe?.sourceUrl).toBe(meta.sourceUrl);
  });

  it("keeps a real source URL and lets the app choose the synthetic base", () => {
    expect(
      paprikaRecipeToRecipe({ ...paprika, source_url: "https://example.com/chili" }).meta
    ).toMatchObject({
      sourceUrl: "https://example.com/chili",
      sourceUrlSynthetic: false
    });
    expect(
      paprikaRecipeToRecipe(paprika, { syntheticSourceBase: "https://linkdish.ca/imported/" }).meta
        .sourceUrl
    ).toMatch(/^https:\/\/linkdish\.ca\/imported\/grandma-s-chili-/u);
  });

  it("is deterministic", () => {
    expect(paprikaRecipeToRecipe(paprika)).toEqual(paprikaRecipeToRecipe(paprika));
  });

  it("drops large photos and reports recipes it cannot import", () => {
    const large = paprikaRecipeToRecipe(paprika, { maxPhotoChars: 4 });
    expect(large.meta.photoDataUrl).toBeNull();
    expect(large.warnings).toEqual(["The photo was too large to keep."]);

    const empty = paprikaRecipeToRecipe({ name: "Just a note", directions: "Think about it." });
    expect(empty.recipe).toBeNull();
    expect(empty.warnings).toEqual(["The recipe has no ingredients, so it can't be imported."]);
    expect(paprikaRecipeToRecipe("nonsense").recipe).toBeNull();
  });
});

describe("melaRecipeToRecipe", () => {
  it("maps Mela's fields, including # group headers", () => {
    const { recipe, meta, warnings } = melaRecipeToRecipe({
      id: "mela-1",
      title: "Lemon Bars",
      text: "Bright and tart.",
      ingredients: "# Crust\n1 cup flour\n1/2 cup butter\n# Filling\n3 eggs\n1 cup sugar",
      instructions: "# Crust\nPress into the pan.\nBake 20 minutes.\n# Filling\nWhisk and pour.",
      yield: "16 bars",
      prepTime: "20 min",
      cookTime: "PT45M",
      link: "https://example.com/lemon-bars",
      notes: "Dust with sugar.",
      categories: ["Baking"],
      favorite: true,
      images: []
    });

    expect(warnings).toEqual([]);
    expect(recipe).toMatchObject({
      title: "Lemon Bars",
      sourceUrl: "https://example.com/lemon-bars",
      sourceType: "recipe-webpage",
      ingredients: [
        { text: "1 cup flour", section: "Crust" },
        { text: "1/2 cup butter", section: "Crust" },
        { text: "3 eggs", section: "Filling" },
        { text: "1 cup sugar", section: "Filling" }
      ],
      steps: [
        { index: 1, text: "Crust: Press into the pan." },
        { index: 2, text: "Bake 20 minutes." },
        { index: 3, text: "Filling: Whisk and pour." }
      ],
      servings: "16 bars",
      prepTimeMinutes: 20,
      cookTimeMinutes: 45,
      description: "Bright and tart."
    });
    expect(meta).toMatchObject({
      favorite: true,
      tags: ["Baking"],
      notes: "Dust with sugar.",
      externalId: "mela-1"
    });
  });
});

describe("schemaOrgRecipeToRecipe", () => {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "Example Kitchen" },
      {
        "@type": ["Recipe", "NewsArticle"],
        name: "Classic Sandwich Bread",
        url: "https://example.com/sandwich-bread?utm_source=x",
        description: "<p>Soft &amp; tender.</p>",
        image: [
          { "@type": "ImageObject", url: "https://example.com/bread.jpg", width: 1200, height: 800 }
        ],
        author: [{ "@type": "Person", name: "Ada Baker" }],
        publisher: { "@type": "Organization", name: "Example Kitchen" },
        recipeYield: ["16", "1 loaf"],
        prepTime: "PT20M",
        cookTime: "PT35M",
        totalTime: "PT3H",
        recipeCuisine: ["American"],
        recipeCategory: "Bread",
        keywords: "bread, sandwich, yeast",
        recipeIngredient: ["3 cups (360g) flour", "1 1/4 teaspoons (8g) table salt"],
        recipeInstructions: [
          {
            "@type": "HowToSection",
            name: "Make the dough",
            itemListElement: [
              { "@type": "HowToStep", text: "Combine everything." },
              { "@type": "HowToStep", text: "Knead 5 to 7 minutes." }
            ]
          },
          { "@type": "HowToStep", text: "Bake at 350&deg;F for 30 to 35 minutes." }
        ],
        video: { "@type": "VideoObject", contentUrl: "https://example.com/bread.mp4" },
        nutrition: {
          "@type": "NutritionInformation",
          calories: "120 kcal",
          sodiumContent: "210 mg"
        },
        aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8" }
      }
    ]
  };

  it("finds the Recipe node in a @graph", () => {
    expect(findSchemaOrgRecipe(jsonLd)?.name).toBe("Classic Sandwich Bread");
    expect(findSchemaOrgRecipe({ "@type": "WebPage" })).toBeNull();
  });

  it("maps schema.org fields into a valid recipe", () => {
    const { recipe, meta, warnings } = schemaOrgRecipeToRecipe(jsonLd, {
      sourceUrl: "https://example.com/sandwich-bread"
    });

    expect(warnings).toEqual([]);
    expect(recipe).toMatchObject({
      title: "Classic Sandwich Bread",
      sourceUrl: "https://example.com/sandwich-bread",
      sourceType: "recipe-webpage",
      image: { url: "https://example.com/bread.jpg", width: 1200, height: 800, source: "jsonld" },
      ingredients: [{ text: "3 cups (360g) flour" }, { text: "1 1/4 teaspoons (8g) table salt" }],
      steps: [
        { index: 1, text: "Make the dough: Combine everything." },
        { index: 2, text: "Knead 5 to 7 minutes." },
        { index: 3, text: "Bake at 350°F for 30 to 35 minutes." }
      ],
      servings: "16, 1 loaf",
      prepTimeMinutes: 20,
      cookTimeMinutes: 35,
      totalTimeMinutes: 180,
      description: "Soft & tender.",
      author: "Ada Baker",
      siteName: "Example Kitchen",
      cuisine: "American",
      category: "Bread",
      keywords: ["bread", "sandwich", "yeast"],
      videoUrl: "https://example.com/bread.mp4",
      nutrition: { calories: "120 kcal", sodium: "210 mg", protein: null }
    });
    expect(recipe?.confidence.fieldProvenance.ingredients).toBe("jsonld");
    expect(meta).toEqual({
      sourceUrl: "https://example.com/sandwich-bread",
      sourceUrlSynthetic: false,
      rating: 5
    });
  });

  it("reports JSON-LD without a recipe", () => {
    expect(schemaOrgRecipeToRecipe({ "@type": "Person" })).toMatchObject({
      recipe: null,
      warnings: ["No schema.org Recipe was found."]
    });
  });

  it("drops an image or video URL longer than the schema allows and keeps the recipe (fuzz)", () => {
    const longUrl = `https://cdn.example.com/img.jpg?${"a".repeat(2100)}`;
    const recipe = {
      "@type": "Recipe",
      name: "S",
      recipeIngredient: ["1 cup water"],
      recipeInstructions: "Boil."
    };

    const withImage = schemaOrgRecipeToRecipe({ ...recipe, image: longUrl });
    expect(withImage.warnings).toEqual([]);
    expect(withImage.recipe).toMatchObject({ title: "S", image: null });

    const withVideo = schemaOrgRecipeToRecipe({ ...recipe, video: { contentUrl: longUrl } });
    expect(withVideo.warnings).toEqual([]);
    expect(withVideo.recipe).toMatchObject({ title: "S", videoUrl: null });

    expect(
      schemaOrgRecipeToRecipe({
        ...recipe,
        image: [{ url: longUrl }, "https://example.com/next.jpg"],
        video: [{ contentUrl: longUrl, embedUrl: "https://example.com/embed" }]
      }).recipe
    ).toMatchObject({
      image: { url: "https://example.com/next.jpg" },
      videoUrl: "https://example.com/embed"
    });

    const paprika = paprikaRecipeToRecipe({
      name: "S",
      ingredients: "1 cup water",
      directions: "Boil.",
      image_url: longUrl
    });
    expect(paprika.warnings).toEqual([]);
    expect(paprika.recipe).toMatchObject({ title: "S", image: null });
  });

  it("round-trips a LinkDish recipe through recipeToJsonLd", () => {
    const { recipe } = schemaOrgRecipeToRecipe(recipeToJsonLd(skillet));

    expect(recipe).toMatchObject({
      title: skillet.title,
      sourceUrl: skillet.sourceUrl,
      ingredients: skillet.ingredients.map((ingredient) => ({ text: ingredient.text })),
      steps: skillet.steps,
      servings: skillet.servings,
      prepTimeMinutes: 10,
      cookTimeMinutes: 20,
      totalTimeMinutes: 30
    });
  });
});

describe("recipe export", () => {
  it("formats plain text for sharing", () => {
    const text = recipeToPlainText(bars, { notes: "Use frozen berries in winter." });

    expect(text.split("\n\n")[0]).toBe(
      "Brown Butter Berry Oat Bars\n9 bars · Prep 15 min · Cook 38 min · Total 53 min"
    );
    expect(text).toContain("INGREDIENTS\nFor the oat base\n• 10 tablespoons unsalted butter");
    expect(text).toContain("STEPS\n1. Heat the oven to 350 F");
    expect(text).toContain("NOTES\nUse frozen berries in winter.");
    expect(text.endsWith("Source: https://linkdish.ca/starter/brown-butter-berry-oat-bars")).toBe(
      true
    );
  });

  it("applies scale and units to ingredients and oven temperatures", () => {
    const text = recipeToPlainText(bars, { scale: 2, units: "metric", includeSource: false });

    expect(text).toContain("18 bars");
    expect(text).toContain("• 280 g unsalted butter");
    expect(text).toContain("1. Heat the oven to 175°C");
    expect(text).not.toContain("Source:");
  });

  it("formats Markdown with escaped text", () => {
    const markdown = recipeToMarkdown({
      ...skillet,
      title: "Chicken *Rice* Skillet",
      sourceUrl: "https://en.wikipedia.org/wiki/Rice_(food)"
    });

    expect(markdown.startsWith("# Chicken \\*Rice\\* Skillet\n\n_Serves 4 · Prep 10 min")).toBe(
      true
    );
    expect(markdown).toContain(
      "## Ingredients\n\n### For the sauce\n\n- 3 tablespoons low-sodium soy sauce"
    );
    expect(markdown).toContain("## Steps\n\n1. Whisk the soy sauce");
    expect(markdown).toContain("[Source](https://en.wikipedia.org/wiki/Rice_%28food%29)");
  });

  it("builds schema.org JSON-LD", () => {
    expect(recipeToJsonLd(skillet, { url: "https://linkdish.ca/r/abc" })).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Recipe",
      name: skillet.title,
      url: "https://linkdish.ca/r/abc",
      recipeYield: "4 servings",
      prepTime: "PT10M",
      cookTime: "PT20M",
      totalTime: "PT30M",
      recipeIngredient: skillet.ingredients.map((ingredient) => ingredient.text)
    });
    expect(toIsoDuration(90)).toBe("PT1H30M");
    expect(toIsoDuration(120)).toBe("PT2H");
    expect(toIsoDuration(0)).toBe("PT0M");
  });
});
