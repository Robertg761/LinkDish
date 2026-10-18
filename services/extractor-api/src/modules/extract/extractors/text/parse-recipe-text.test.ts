import { describe, expect, it } from "vitest";

import { findTextLinks, parseRecipeText } from "./parse-recipe-text";

describe("parseRecipeText", () => {
  it("reads a labelled recipe with metadata, bullets, numbered steps and notes", () => {
    const parsed = parseRecipeText(
      [
        "Grandma's Banana Bread",
        "",
        "Serves 8",
        "Prep time: 15 mins | Cook time: 1 hour",
        "",
        "Ingredients",
        "- 3 ripe bananas, mashed",
        "- 1/3 cup melted butter",
        "• 1 egg, beaten",
        "▢ Pinch of salt",
        "- 1 1/2 cups all-purpose flour",
        "",
        "Instructions",
        "1. Preheat the oven to 350°F and butter a loaf pan.",
        "2. Mash the bananas. Stir in the butter.",
        "   Then the egg.",
        "3. Bake for 55 to 65 minutes.",
        "",
        "Notes",
        "Freezes well."
      ].join("\n")
    );

    expect(parsed).toEqual({
      title: "Grandma's Banana Bread",
      ingredients: [
        { text: "3 ripe bananas, mashed", section: null },
        { text: "1/3 cup melted butter", section: null },
        { text: "1 egg, beaten", section: null },
        { text: "Pinch of salt", section: null },
        { text: "1 1/2 cups all-purpose flour", section: null }
      ],
      steps: [
        "Preheat the oven to 350°F and butter a loaf pan.",
        "Mash the bananas. Stir in the butter.",
        "Then the egg.",
        "Bake for 55 to 65 minutes."
      ],
      servings: "8",
      prepTimeMinutes: 15,
      cookTimeMinutes: 60,
      totalTimeMinutes: null,
      structure: "headings",
      methodSource: "heading"
    });
  });

  it("keeps ingredient sections and names them in the method", () => {
    const parsed = parseRecipeText(
      [
        "Chocolate Cake",
        "Ingredients",
        "For the cake:",
        "2 cups flour",
        "1 cup sugar",
        "For the frosting:",
        "1 cup butter",
        "2 cups icing sugar",
        "Method",
        "Cake:",
        "Mix the dry ingredients and bake at 180C for 30 minutes.",
        "Frosting:",
        "Beat the butter and icing sugar until fluffy."
      ].join("\n")
    );

    expect(parsed.ingredients).toEqual([
      { text: "2 cups flour", section: "Cake" },
      { text: "1 cup sugar", section: "Cake" },
      { text: "1 cup butter", section: "Frosting" },
      { text: "2 cups icing sugar", section: "Frosting" }
    ]);
    expect(parsed.steps).toEqual([
      "Cake: Mix the dry ingredients and bake at 180C for 30 minutes.",
      "Frosting: Beat the butter and icing sugar until fluffy."
    ]);
  });

  it("splits a caption that runs the whole recipe into one line", () => {
    const parsed = parseRecipeText(
      "The easiest garlic butter pasta 🍝🧄 Ingredients: 200g spaghetti, 3 cloves garlic, minced, 2 tbsp butter, salt and pepper to taste Method: 1. Boil the pasta in salted water. 2. Melt the butter and fry the garlic for 1 minute. 3. Toss everything together. #pasta #foodtok"
    );

    expect(parsed.title).toBe("The easiest garlic butter pasta");
    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "200g spaghetti",
      "3 cloves garlic, minced",
      "2 tbsp butter",
      "salt and pepper to taste"
    ]);
    expect(parsed.steps).toEqual([
      "Boil the pasta in salted water.",
      "Melt the butter and fry the garlic for 1 minute.",
      "Toss everything together."
    ]);
  });

  it("reads an unlabelled recipe from its layout", () => {
    const parsed = parseRecipeText(
      [
        "Lemon chicken",
        "2 chicken breasts",
        "1 lemon, juiced",
        "Fresh oregano",
        "2 tbsp olive oil",
        "Marinate the chicken in the lemon, oil and oregano for 20 minutes.",
        "Grill for 6-7 minutes per side until cooked through."
      ].join("\n")
    );

    expect(parsed).toMatchObject({
      title: "Lemon chicken",
      structure: "layout",
      ingredients: [
        { text: "2 chicken breasts" },
        { text: "1 lemon, juiced" },
        { text: "Fresh oregano" },
        { text: "2 tbsp olive oil" }
      ],
      steps: [
        "Marinate the chicken in the lemon, oil and oregano for 20 minutes.",
        "Grill for 6-7 minutes per side until cooked through."
      ]
    });
  });

  it("splits a single method paragraph into sentences", () => {
    const parsed = parseRecipeText(
      [
        "Simple pancakes",
        "Ingredients: 1 cup flour, 1 cup milk, 1 egg, pinch of salt",
        "Directions: Whisk everything together until smooth. Heat a pan over medium heat. Pour in 1/4 cup of batter, cook until bubbles form, then flip and cook for 1 more minute."
      ].join("\n")
    );

    expect(parsed.steps).toEqual([
      "Whisk everything together until smooth.",
      "Heat a pan over medium heat.",
      "Pour in 1/4 cup of batter, cook until bubbles form, then flip and cook for 1 more minute."
    ]);
  });

  it("does not read amounts in a method as step numbers or times", () => {
    const parsed = parseRecipeText(
      [
        "Ingredients",
        "1.5 cups rice",
        "2-3 cloves garlic",
        "Method",
        "Cook the rice for 10 minutes.",
        "Cook time: 10 min"
      ].join("\n")
    );

    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "1.5 cups rice",
      "2-3 cloves garlic"
    ]);
    expect(parsed.steps).toEqual(["Cook the rice for 10 minutes."]);
    expect(parsed.cookTimeMinutes).toBe(10);
  });

  it("drops channel chrome from a video description", () => {
    const parsed = parseRecipeText(
      [
        "In this video I make my favourite stew!",
        "INGREDIENTS:",
        "500g beef chuck",
        "2 carrots",
        "Full recipe: https://cookblog.example/beef-stew/",
        "Follow me on Instagram: https://instagram.com/cook",
        "0:00 Intro",
        "#stew #dinner"
      ].join("\n")
    );

    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "500g beef chuck",
      "2 carrots"
    ]);
    expect(parsed.steps).toEqual([]);
  });

  it("reads an ingredient list with section names and notes, and stops at the sign-off", () => {
    const parsed = parseRecipeText(
      [
        "Tasty Recipe:",
        "Flour:",
        "50g Glutinous rice flour",
        "Filling:",
        "200g Cream cheese",
        "40g Sugar",
        "*Freezing 2 hour",
        "",
        "100g Chocolate",
        "18g Corn oil",
        "Spring onion",
        "",
        "*Decoration",
        "Chocolate sprinkles",
        "",
        "Thanks for watching♥",
        "Like👍 and share this video 🌹",
        "Chocolate tarts: https://youtu.be/abc",
        "#cake"
      ].join("\n")
    );

    expect(parsed.ingredients).toEqual([
      { text: "50g Glutinous rice flour", section: "Flour" },
      { text: "200g Cream cheese", section: "Filling" },
      { text: "40g Sugar", section: "Filling" },
      { text: "100g Chocolate", section: "Filling" },
      { text: "18g Corn oil", section: "Filling" },
      { text: "Spring onion", section: "Filling" },
      { text: "Chocolate sprinkles", section: "Decoration" }
    ]);
    expect(parsed.steps).toEqual(["Freezing 2 hour"]);
    expect(parsed.methodSource).toBe("notes");
  });

  it("splits a short one-line recipe at its labels", () => {
    const parsed = parseRecipeText(
      "Ingredients: 2 eggs, 1 cup flour Method: Mix together and bake."
    );

    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "2 eggs",
      "1 cup flour"
    ]);
    expect(parsed.steps).toEqual(["Mix together and bake."]);
  });

  it("splits a short bulleted line and keeps unit abbreviations in inline ingredients", () => {
    expect(
      parseRecipeText("Ingredients: 2 eggs • 1 cup flour Method: Mix and bake.").ingredients
    ).toEqual([
      { text: "2 eggs", section: null },
      { text: "1 cup flour", section: null }
    ]);

    const parsed = parseRecipeText(
      "Ingredients: 1 tsp. Salt, 2 cups Flour\nMethod: Mix together. Bake for 20 minutes."
    );

    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "1 tsp. Salt",
      "2 cups Flour"
    ]);
    expect(parsed.steps).toEqual(["Mix together.", "Bake for 20 minutes."]);
  });

  it("keeps decimal commas and reads a labelled title line", () => {
    const parsed = parseRecipeText(
      ["Title: Pancakes", "Ingredients: 1,5 kg flour, 2 eggs", "Method", "Mix and fry."].join("\n")
    );

    expect(parsed.title).toBe("Pancakes");
    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "1,5 kg flour",
      "2 eggs"
    ]);
  });

  it("reads a duration written with a comma", () => {
    const parsed = parseRecipeText(
      [
        "Serves 4, Prep time: 1 hour, 30 minutes",
        "Ingredients",
        "2 eggs",
        "1 cup flour",
        "Method",
        "Mix and bake."
      ].join("\n")
    );

    expect(parsed.servings).toBe("4");
    expect(parsed.prepTimeMinutes).toBe(90);
  });

  it("reads fractional hours and keeps method steps that start with 'Follow'", () => {
    const parsed = parseRecipeText(
      [
        "Prep time: 1.5 hours | Cook time: 1 hour 15 min",
        "Ingredients",
        "200g noodles",
        "2 tbsp soy sauce",
        "Method",
        "Follow the package directions to cook the noodles.",
        "Follow me on Instagram"
      ].join("\n")
    );

    expect(parsed.prepTimeMinutes).toBe(90);
    expect(parsed.cookTimeMinutes).toBe(75);
    expect(parsed.steps).toEqual(["Follow the package directions to cook the noodles."]);
  });

  it("keeps a method step that starts with 'Note' and stops at a 'Notes' heading", () => {
    const parsed = parseRecipeText(
      [
        "Ingredients",
        "500g flour",
        "300ml water",
        "Method",
        "Mix the dough.",
        "Note the dough is sticky.",
        "Bake for 20 minutes.",
        "Notes for storage",
        "Keeps for 3 days."
      ].join("\n")
    );

    expect(parsed.steps).toEqual([
      "Mix the dough.",
      "Note the dough is sticky.",
      "Bake for 20 minutes."
    ]);
  });

  it("reads inline ingredients after an 'Ingredient list:' heading", () => {
    const parsed = parseRecipeText("Ingredient list: 2 eggs, 1 cup flour Method: Mix and bake.");

    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "2 eggs",
      "1 cup flour"
    ]);
    expect(parsed.steps).toEqual(["Mix and bake."]);
  });

  it("reads unpunctuated times, but keeps a lone 'Cook 20 minutes.' as a step", () => {
    const parsed = parseRecipeText(
      [
        "Prep 10 min | Cook 20 min",
        "Total 1 hour",
        "Ingredients",
        "200g pasta",
        "1 jar pesto",
        "Method",
        "Boil the pasta.",
        "Cook 20 minutes.",
        "Stir in the pesto."
      ].join("\n")
    );

    expect(parsed).toMatchObject({
      prepTimeMinutes: 10,
      cookTimeMinutes: 20,
      totalTimeMinutes: 60
    });
    expect(parsed.steps).toEqual(["Boil the pasta.", "Cook 20 minutes.", "Stir in the pesto."]);
  });

  it("drops the list numbers from a numbered ingredient list", () => {
    const withHeadings = parseRecipeText(
      ["Ingredients", "1. 2 eggs", "2. 1 cup flour", "Method", "1. Mix.", "2. Bake."].join("\n")
    );
    const byLayout = parseRecipeText(
      [
        "1. 2 eggs",
        "2. 1 cup flour",
        "3. 1 cup milk",
        "Whisk everything together and bake for 20 minutes."
      ].join("\n")
    );

    expect(withHeadings.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "2 eggs",
      "1 cup flour"
    ]);
    expect(withHeadings.steps).toEqual(["Mix.", "Bake."]);
    expect(byLayout.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "2 eggs",
      "1 cup flour",
      "1 cup milk"
    ]);
  });

  it("splits a one-line recipe at any method heading it knows", () => {
    const parsed = parseRecipeText("Ingredients: 2 eggs, 1 cup flour Preparation: Mix and bake.");

    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "2 eggs",
      "1 cup flour"
    ]);
    expect(parsed.steps).toEqual(["Mix and bake."]);
  });

  it("reads day-scale times", () => {
    expect(
      parseRecipeText(
        [
          "Total time: 1 day 2 hours",
          "Ingredients",
          "1 kg flour",
          "700g water",
          "Method",
          "Mix."
        ].join("\n")
      ).totalTimeMinutes
    ).toBe(1560);
    expect(
      parseRecipeText(
        ["Total time: 1 day", "Ingredients", "1 kg flour", "700g water", "Method", "Mix."].join(
          "\n"
        )
      ).totalTimeMinutes
    ).toBe(1440);
  });

  it("ends at a sign-off after a list of unmeasured ingredients", () => {
    const parsed = parseRecipeText(
      [
        "Ingredients",
        "Salt",
        "Pepper",
        "Method",
        "Season the steak.",
        "Thanks for watching",
        "New videos every Friday"
      ].join("\n")
    );

    expect(parsed.steps).toEqual(["Season the steak."]);
  });

  it("keeps recipe-link labels out of the method", () => {
    const parsed = parseRecipeText(
      [
        "Ingredients",
        "2 eggs",
        "1 cup flour",
        "Method",
        "Mix and bake.",
        "Full recipe: https://example.com/post",
        "My cookbook: https://example.com/book",
        "Printable recipe:",
        "https://example.com/print"
      ].join("\n")
    );

    expect(parsed.steps).toEqual(["Mix and bake."]);
  });

  it("reads 'Preparation time' as a time, not the method heading", () => {
    const parsed = parseRecipeText(
      [
        "Ingredients",
        "2 eggs",
        "1 cup flour",
        "Preparation time: 15 minutes",
        "Pinch of salt",
        "Method",
        "Mix and bake."
      ].join("\n")
    );

    expect(parsed.prepTimeMinutes).toBe(15);
    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "2 eggs",
      "1 cup flour",
      "Pinch of salt"
    ]);
    expect(parsed.steps).toEqual(["Mix and bake."]);
  });

  it("splits short inline numbered steps", () => {
    expect(
      parseRecipeText("Ingredients: 2 eggs, 1 cup flour Method: 1. Mix. 2. Bake.").steps
    ).toEqual(["Mix.", "Bake."]);
  });

  it("ignores everything after a 'Thanks for watching' sign-off", () => {
    const parsed = parseRecipeText(
      [
        "Ingredients",
        "200g flour",
        "2 eggs",
        "Thanks for watching!",
        "2 cups of love from my channel",
        "My knives 20% off"
      ].join("\n")
    );

    expect(parsed.ingredients.map((ingredient) => ingredient.text)).toEqual([
      "200g flour",
      "2 eggs"
    ]);
  });

  it("reads notes between groups of an unlabelled list", () => {
    const parsed = parseRecipeText(
      [
        "75g Butter",
        "2 tbsp Sugar",
        "130g All purpose flour",
        "*Chill in the fridge for 30 minutes",
        "110g Chocolate",
        "125ml Whipping cream",
        "Decoration",
        "Shredded coconut",
        "Subscribe my YouTube channel"
      ].join("\n")
    );

    expect(parsed).toMatchObject({
      structure: "layout",
      methodSource: "notes",
      steps: ["Chill in the fridge for 30 minutes"]
    });
    expect(parsed.ingredients.at(-1)).toEqual({ text: "Shredded coconut", section: "Decoration" });
  });

  it("reports no structure for text that is not a recipe", () => {
    expect(parseRecipeText("the best pasta ever 😍 #foodtok #pasta").structure).toBeNull();
    expect(
      parseRecipeText("Thanks for dinner last night, it was lovely to see you all!").structure
    ).toBeNull();
    expect(
      parseRecipeText(
        "My chili: brown 1 lb beef with 2 tbsp chili powder, then add 1 can beans and simmer."
      ).structure
    ).toBeNull();
  });
});

describe("findTextLinks", () => {
  it("returns each link with its line and the line above", () => {
    expect(findTextLinks("Full recipe:\nhttps://cookblog.example/stew.\nhi")).toEqual([
      { url: "https://cookblog.example/stew", line: "Full recipe: https://cookblog.example/stew." }
    ]);
  });
});
