import { describe, expect, it } from "vitest";

import { inferRecipeTags, SAMPLE_RECIPES } from "./index.js";

type Fixture = Parameters<typeof inferRecipeTags>[0];

const fixture = (
  title: string,
  ingredients: readonly string[],
  steps: readonly string[],
  extra: Partial<Fixture> = {}
): Fixture => ({
  title,
  ingredients: ingredients.map((text) => ({ text })),
  steps: steps.map((text, index) => ({ index: index + 1, text })),
  prepTimeMinutes: null,
  cookTimeMinutes: null,
  ...extra
});

describe("inferRecipeTags on the starter recipes", () => {
  it("suggests conservative tags with reasons", () => {
    const [skillet, bars, pitas] = SAMPLE_RECIPES.map((sample) => inferRecipeTags(sample.recipe));

    expect(skillet?.tags).toEqual(["dinner", "one-pot", "quick"]);
    expect(skillet?.cuisine).toBeNull();
    expect(skillet?.diet).toEqual([]);
    expect(skillet?.quick).toEqual({ value: "quick", reason: "Ready in 30 min" });

    expect(bars?.tags).toEqual(["dessert", "bake", "vegetarian"]);
    expect(bars?.course?.reason).toBe('"bars" in the title with sweet ingredients');

    expect(pitas?.tags).toEqual(["lunch", "mediterranean", "vegetarian", "quick"]);
    expect(pitas?.diet.map((entry) => entry.value)).toEqual(["vegetarian"]);
    expect(pitas?.cuisine?.reason).toMatch(/^Signature ingredients or dishes: /u);
  });
});

describe("inferRecipeTags fixtures", () => {
  it("reads courses from titles and schema.org categories", () => {
    const courses = [
      fixture("Classic Chocolate Chip Cookies", ["2 cups flour"], ["Bake."]),
      fixture("Fluffy Pancakes", ["1 cup flour"], ["Cook on a griddle."]),
      fixture("Classic Sandwich Bread", ["3 cups flour"], ["Bake."]),
      fixture("Strawberry Smoothie", ["1 cup strawberries"], ["Blend."]),
      fixture("Garlicky Green Beans", ["1 lb green beans"], ["Saute."], { category: "Side Dish" }),
      fixture("Chicken Pot Pie", ["1 lb chicken"], ["Bake."]),
      fixture("Seven-Layer Dip", ["1 can refried beans"], ["Layer."]),
      fixture("Weeknight Something", ["1 onion"], ["Cook."]),
      fixture("Grandma's Special", ["1 onion"], ["Cook."], { category: "Main Course" })
    ].map((recipe) => inferRecipeTags(recipe).course?.value ?? null);

    expect(courses).toEqual([
      "dessert",
      "breakfast",
      "baking",
      "drink",
      "side",
      "dinner",
      "snack",
      null,
      "dinner"
    ]);
  });

  it("names a cuisine only with a clear lead", () => {
    const cuisines = [
      fixture(
        "Jo Mama's World Famous Spaghetti",
        ["2 lbs Italian sausage", "1 lb thin spaghetti", "parmesan cheese"],
        ["Simmer."]
      ),
      fixture(
        "Weeknight Chicken Tacos",
        ["8 corn tortillas", "1 jalapeño", "1/2 cup salsa", "1 lb chicken"],
        ["Cook."]
      ),
      fixture(
        "Green Curry",
        [
          "2 tbsp green curry paste",
          "1 can coconut milk",
          "2 tbsp fish sauce",
          "1 stalk lemongrass"
        ],
        ["Simmer."]
      ),
      fixture(
        "Chana Masala",
        ["1 can chickpeas", "1 tsp garam masala", "1 tsp turmeric"],
        ["Simmer."]
      ),
      fixture("Beef Bulgogi", ["1 lb beef", "2 tbsp gochujang"], ["Grill."]),
      // Soy sauce and rice vinegar are shared by several cuisines: no suggestion.
      fixture("Sesame Noodles", ["2 tbsp soy sauce", "1 tbsp rice vinegar"], ["Toss."]),
      fixture("House Salad", ["1 head lettuce"], ["Toss."], { cuisine: "Greek" })
    ].map((recipe) => inferRecipeTags(recipe).cuisine?.value ?? null);

    expect(cuisines).toEqual([
      "italian",
      "mexican",
      "thai",
      "indian",
      "korean",
      null,
      "mediterranean"
    ]);
  });

  it("detects cooking methods", () => {
    const methods = [
      fixture(
        "Slow Cooker Pot Roast",
        ["3 lb chuck roast"],
        ["Cook on low 8 hours in the slow cooker."]
      ),
      fixture("Instant Pot Chili", ["1 lb beef"], ["Pressure cook on high for 15 minutes."]),
      fixture("Air Fryer Wings", ["2 lb wings"], ["Air fry at 400°F for 20 minutes."]),
      fixture("Sheet Pan Sausage and Peppers", ["1 lb sausage"], ["Roast on a sheet pan."]),
      fixture("Grilled Corn", ["4 ears corn"], ["Preheat the grill to high."]),
      fixture("One-Pot Pasta", ["1 lb pasta"], ["Boil everything in a large pot."]),
      fixture("No-Bake Cheesecake Bars", ["1 cup cream cheese"], ["Chill 4 hours."]),
      fixture(
        "Chocolate Icebox Cake",
        ["1 cup cream", "1 box chocolate wafers"],
        ["Layer the wafers and cream, then refrigerate overnight."]
      ),
      fixture("Roast Chicken", ["1 whole chicken"], ["Roast in a 425°F oven for 1 hour."])
    ].map((recipe) => inferRecipeTags(recipe).method.map((entry) => entry.value));

    expect(methods).toEqual([
      ["slow-cooker"],
      ["instant-pot"],
      ["air-fryer"],
      ["sheet-pan", "bake"],
      ["grill"],
      ["one-pot"],
      ["no-bake"],
      ["no-bake"],
      ["bake"]
    ]);
  });

  it("only calls a recipe vegetarian or vegan when nothing rules it out", () => {
    const diets = [
      fixture(
        "Tomato Soup",
        ["1 can tomatoes", "1 onion", "2 cups vegetable broth", "1 tbsp olive oil"],
        ["Simmer."]
      ),
      fixture("Tomato Soup", ["1 can tomatoes", "2 cups broth"], ["Simmer."]),
      fixture("Cheese Toast", ["2 slices bread", "1 cup cheddar"], ["Toast."]),
      fixture("Caesar Dressing", ["1 tsp Worcestershire sauce", "1/2 cup olive oil"], ["Whisk."]),
      fixture(
        "Peanut Noodles",
        ["8 oz rice noodles", "1/4 cup peanut butter", "2 tbsp soy sauce"],
        ["Toss."]
      ),
      fixture("Honey Oat Bars", ["2 cups oats", "1/2 cup honey"], ["Bake."]),
      fixture("Celery Snack", ["2 celery ribs", "2 tbsp almond butter"], ["Spread."]),
      fixture("Vegan Bacon Bits", ["1 cup vegan bacon"], ["Crisp."]),
      fixture("Oyster Mushroom Tacos", ["8 oz oyster mushrooms", "6 corn tortillas"], ["Sear."]),
      fixture("Empty", [], [])
    ].map((recipe) => inferRecipeTags(recipe).diet.map((entry) => entry.value));

    expect(diets).toEqual([
      ["vegetarian", "vegan"],
      [],
      ["vegetarian"],
      [],
      ["vegetarian", "vegan"],
      ["vegetarian"],
      ["vegetarian", "vegan"],
      ["vegetarian", "vegan"],
      ["vegetarian", "vegan"],
      []
    ]);
  });

  it("marks quick recipes from the total time only", () => {
    const quick = (extra: Partial<Fixture>) =>
      inferRecipeTags(fixture("Toast", ["1 slice bread"], ["Toast."], extra)).quick?.value ?? null;

    expect(quick({ prepTimeMinutes: 5, cookTimeMinutes: 5 })).toBe("quick");
    expect(quick({ totalTimeMinutes: 30 })).toBe("quick");
    expect(quick({ prepTimeMinutes: 10, cookTimeMinutes: 25 })).toBeNull();
    expect(quick({ prepTimeMinutes: 5, cookTimeMinutes: 5, totalTimeMinutes: 120 })).toBeNull();
    expect(quick({})).toBeNull();
  });
});
