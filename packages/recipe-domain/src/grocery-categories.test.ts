import { describe, expect, it } from "vitest";

import {
  categorizeIngredient,
  groupByShoppingCategory,
  SAMPLE_RECIPES,
  SHOPPING_CATEGORIES,
  SHOPPING_CATEGORY_IDS,
  shoppingCategoryRank
} from "./index.js";

import type { ShoppingCategoryId } from "./index.js";

/**
 * Real ingredient lines: the starter recipes, the featured King Arthur / Allrecipes recipes the
 * web app ships, and common staples, each with the aisle a shopper would expect.
 */
const categoryCorpus: ReadonlyArray<readonly [string, ShoppingCategoryId]> = [
  // Starter recipes
  ["3 tablespoons low-sodium soy sauce", "condiments"],
  ["1 tablespoon rice vinegar", "condiments"],
  ["1 tablespoon honey", "pantry"],
  ["2 teaspoons toasted sesame oil", "pantry"],
  ["2 teaspoons grated fresh ginger", "produce"],
  ["1 pound boneless skinless chicken thighs, cut into bite-size pieces", "meat-seafood"],
  ["1 tablespoon neutral oil", "pantry"],
  ["1 red bell pepper, thinly sliced", "produce"],
  ["2 cups snap peas, strings removed", "produce"],
  ["2 scallions, sliced", "produce"],
  ["3 cups cooked jasmine rice", "pantry"],
  ["1 teaspoon toasted sesame seeds", "pantry"],
  ["10 tablespoons unsalted butter", "dairy-eggs"],
  ["1 cup rolled oats", "pantry"],
  ["1 cup all-purpose flour", "baking"],
  ["1/2 cup light brown sugar, packed", "baking"],
  ["1/2 teaspoon baking powder", "baking"],
  ["1/2 teaspoon fine sea salt", "spices"],
  ["1 1/2 cups mixed berries, fresh or frozen", "produce"],
  ["2 tablespoons granulated sugar", "baking"],
  ["1 tablespoon lemon juice", "produce"],
  ["2 teaspoons cornstarch", "baking"],
  ["1 tablespoon coarse sugar, optional", "baking"],
  ["1 can chickpeas, drained and rinsed", "canned"],
  ["1 Persian cucumber, diced", "produce"],
  ["1 cup cherry tomatoes, quartered", "produce"],
  ["1/4 cup crumbled feta", "dairy-eggs"],
  ["2 tablespoons plain Greek yogurt", "dairy-eggs"],
  ["1 tablespoon olive oil", "pantry"],
  ["1 teaspoon chopped dill", "produce"],
  ["2 pita pockets, halved", "bakery"],
  ["2 handfuls baby spinach", "produce"],
  // Featured recipes
  ["3 cups (360g) King Arthur Unbleached All-Purpose Flour", "baking"],
  ["1/2 cup (113g) milk, (skim, 1%, 2% or whole, your choice)*", "dairy-eggs"],
  ["1/2 to 2/3 cup (113g to 152g) hot water, enough to make a soft, smooth dough", "other"],
  ["4 tablespoons (57g) melted butter or 1/4 cup (50g) vegetable oil", "dairy-eggs"],
  ["2 tablespoons (25g) granulated sugar", "baking"],
  ["1 1/4 teaspoons (8g) table salt", "spices"],
  ["2 teaspoons instant yeast", "baking"],
  ["2 teaspoons active dry yeast or instant yeast", "baking"],
  ["7/8 to 1 1/8 cups (198g to 255g) lukewarm water*", "other"],
  ["2 tablespoons (25g) olive oil", "pantry"],
  ["2/3 cup (142g) light brown sugar, packed", "baking"],
  ["8 tablespoons (113g) unsalted butter", "dairy-eggs"],
  ["1/2 cup (92g) vegetable shortening", "baking"],
  ["3/4 teaspoon table salt, (use 1/2 teaspoon salt if you use salted butter)", "spices"],
  ["2 teaspoons King Arthur Pure Vanilla Extract", "baking"],
  ["1/4 teaspoon almond extract, optional", "baking"],
  ["1 teaspoon cider vinegar or white vinegar", "condiments"],
  ["1 teaspoon baking soda", "baking"],
  ["1 large egg", "dairy-eggs"],
  ["2 cups (340g) semisweet chocolate chips*", "baking"],
  ["1 teaspoon ground cinnamon", "spices"],
  ["1/4 teaspoon ground nutmeg", "spices"],
  ["1 1/2 cups (340g) bananas, mashed", "produce"],
  ["3 tablespoons (64g) apricot jam or orange marmalade, optional but tasty", "condiments"],
  ["1/4 cup (85g) honey", "pantry"],
  ["2 large eggs", "dairy-eggs"],
  ["1/2 cup (57g) chopped walnuts, optional", "pantry"],
  ["2 lbs Italian sausage, casings removed (mild or hot)", "meat-seafood"],
  ["1 small onion, chopped (optional)", "produce"],
  ["3 -4 garlic cloves, minced", "produce"],
  ["1 (28 ounce) can diced tomatoes", "canned"],
  ["2 (6 ounce) cans tomato paste", "canned"],
  ["2 (15 ounce) cans tomato sauce", "canned"],
  ["2 cups water (for a long period of simmering)", "other"],
  ["3 teaspoons basil", "spices"],
  ["2 teaspoons dried parsley flakes", "spices"],
  ["1 1/2 teaspoons brown sugar", "baking"],
  ["1 teaspoon salt", "spices"],
  ["1/4-1/2 teaspoon crushed red pepper flakes", "spices"],
  ["1/4 teaspoon fresh coarse ground black pepper", "spices"],
  ["1/4 cup red wine (a good Cabernet!)", "beverages"],
  ["1 lb thin spaghetti", "pantry"],
  ["parmesan cheese", "dairy-eggs"],
  ["3/4 cup milk", "dairy-eggs"],
  ["2 tablespoons butter or 2 tablespoons margarine, melted", "dairy-eggs"],
  ["1 cup flour", "baking"],
  ["1 tablespoon sugar (or 1/2 teaspoon honey or molasses)", "baking"],
  ["4 lbs pork ribs, membrane removed", "meat-seafood"],
  ["3/4 cup light brown sugar", "baking"],
  ["1 teaspoon hickory smoke salt", "spices"],
  ["1 tablespoon paprika", "spices"],
  ["1 tablespoon garlic powder", "spices"],
  ["1/2 teaspoon ground red pepper (optional)", "spices"],
  ["2 cups of your favorite barbecue sauce (mine is Sweet Baby Ray)", "condiments"],
  // Produce
  ["2 ripe avocados", "produce"],
  ["1 bunch cilantro", "produce"],
  ["3 sprigs fresh thyme", "produce"],
  ["3 sprigs thyme", "produce"],
  ["1 head cauliflower", "produce"],
  ["2 medium sweet potatoes, peeled", "produce"],
  ["1 lb baby potatoes", "produce"],
  ["2 carrots, diced", "produce"],
  ["2 celery stalks, chopped", "produce"],
  ["1 jalapeño, seeded and minced", "produce"],
  ["8 oz cremini mushrooms, sliced", "produce"],
  ["1 zucchini", "produce"],
  ["2 limes, juiced", "produce"],
  ["1 lemon, zested", "produce"],
  ["1 bunch green onions", "produce"],
  ["1 pint strawberries", "produce"],
  ["1 cup fresh basil leaves", "produce"],
  ["1 package (14 oz) extra-firm tofu", "produce"],
  ["1 lb asparagus, trimmed", "produce"],
  ["1 eggplant", "produce"],
  ["1 cup green beans", "produce"],
  ["2 ears corn", "produce"],
  // Meat and seafood
  ["1 lb ground beef", "meat-seafood"],
  ["1 lb ground turkey", "meat-seafood"],
  ["6 slices bacon", "meat-seafood"],
  ["1 lb large shrimp, peeled and deveined", "meat-seafood"],
  ["4 (6 ounce) salmon fillets", "meat-seafood"],
  ["2 boneless skinless chicken breasts", "meat-seafood"],
  ["1 (3 lb) pork shoulder", "meat-seafood"],
  ["4 oz prosciutto", "meat-seafood"],
  // Dairy and eggs
  ["1 cup heavy cream", "dairy-eggs"],
  ["8 oz cream cheese, softened", "dairy-eggs"],
  ["1/2 cup sour cream", "dairy-eggs"],
  ["1 cup buttermilk", "dairy-eggs"],
  ["2 cups shredded mozzarella", "dairy-eggs"],
  ["1 cup ricotta", "dairy-eggs"],
  ["3 egg yolks", "dairy-eggs"],
  ["1 cup oat milk", "dairy-eggs"],
  // Bakery
  ["8 flour tortillas", "bakery"],
  ["4 hamburger buns", "bakery"],
  ["1 baguette", "bakery"],
  ["2 slices sourdough bread", "bakery"],
  ["1 refrigerated pie crust", "bakery"],
  // Pantry
  ["8 oz penne pasta", "pantry"],
  ["1 cup long-grain white rice", "pantry"],
  ["1 cup panko breadcrumbs", "pantry"],
  ["1/2 cup peanut butter", "pantry"],
  ["1/4 cup maple syrup", "pantry"],
  ["1/2 cup quinoa", "pantry"],
  ["8 oz egg noodles", "pantry"],
  ["1/4 cup pine nuts", "pantry"],
  // Baking
  ["1 cup powdered sugar", "baking"],
  ["1/2 cup cocoa powder", "baking"],
  ["2 cups bread flour", "baking"],
  ["1 tsp lemon extract", "baking"],
  ["1/2 cup shredded coconut", "baking"],
  // Spices
  ["1 tsp ground cumin", "spices"],
  ["1 tsp dried oregano", "spices"],
  ["1 tsp oregano", "spices"],
  ["2 bay leaves", "spices"],
  ["1/2 tsp cayenne pepper", "spices"],
  ["Salt and pepper to taste", "spices"],
  ["1/4 tsp ground cloves", "spices"],
  ["1 tablespoon Italian seasoning", "spices"],
  // Canned and jarred
  ["4 cups chicken broth", "canned"],
  ["1 (13.5 oz) can coconut milk", "canned"],
  ["1 (15 oz) can black beans, drained", "canned"],
  ["1 can (15 oz) pumpkin puree", "canned"],
  ["2 cups low-sodium vegetable stock", "canned"],
  ["1 jar marinara sauce", "canned"],
  ["1 (5 oz) can tuna", "canned"],
  ["1/4 cup sun-dried tomatoes", "canned"],
  ["1 can water chestnuts", "canned"],
  // Condiments
  ["2 tbsp Dijon mustard", "condiments"],
  ["1/4 cup mayonnaise", "condiments"],
  ["1 tbsp fish sauce", "condiments"],
  ["2 tbsp sriracha", "condiments"],
  ["1/4 cup red wine vinegar", "condiments"],
  ["1 tbsp Worcestershire sauce", "condiments"],
  ["1/2 cup salsa", "condiments"],
  ["2 tbsp capers", "condiments"],
  ["1 tbsp white miso", "condiments"],
  ["2 tbsp Shaoxing rice wine", "condiments"],
  // Frozen
  ["1 cup frozen peas", "frozen"],
  ["1 sheet puff pastry, thawed", "frozen"],
  ["1 pint vanilla ice cream", "frozen"],
  ["2 cups frozen corn", "frozen"],
  // Beverages
  ["1 cup dry white wine", "beverages"],
  ["1/2 cup orange juice", "beverages"],
  ["1 bottle beer", "beverages"],
  ["1 cup brewed coffee", "beverages"],
  ["2 oz bourbon", "beverages"],
  ["1 cup sparkling water", "beverages"],
  // Other
  ["1 cup ice water", "other"],
  ["Cooking twine", "other"],
  ["Parchment paper", "other"]
];

describe("categorizeIngredient", () => {
  it("files the labelled corpus of real ingredient lines into the expected aisles", () => {
    expect(categoryCorpus).toHaveLength(182);

    const misses = categoryCorpus
      .map(([text, expected]) => ({ text, expected, actual: categorizeIngredient(text) }))
      .filter(({ expected, actual }) => expected !== actual);

    expect(misses).toEqual([]);
  });

  it("covers every aisle", () => {
    const covered = new Set(categoryCorpus.map(([, category]) => category));

    expect([...covered].sort()).toEqual([...SHOPPING_CATEGORY_IDS].sort());
  });

  it("only returns known aisles, including for the starter recipes", () => {
    for (const sample of SAMPLE_RECIPES) {
      for (const ingredient of sample.recipe.ingredients) {
        expect(SHOPPING_CATEGORY_IDS).toContain(categorizeIngredient(ingredient.text));
      }
    }
  });

  it("matches whole words only", () => {
    expect(categorizeIngredient("1 eggplant")).toBe("produce");
    expect(categorizeIngredient("1 cup buttermilk")).toBe("dairy-eggs");
    expect(categorizeIngredient("2 cups sugar snap peas")).toBe("produce");
    expect(categorizeIngredient("1 cup butter beans")).toBe("canned");
    expect(categorizeIngredient("1 tbsp cornmeal")).toBe("baking");
  });
});

describe("shopping aisles", () => {
  it("orders aisles in store-walk order with labels", () => {
    expect(SHOPPING_CATEGORIES.map((category) => category.id)).toEqual([...SHOPPING_CATEGORY_IDS]);
    expect(shoppingCategoryRank("produce")).toBe(0);
    expect(shoppingCategoryRank("other")).toBe(SHOPPING_CATEGORY_IDS.length - 1);
  });

  it("groups items by aisle, keeping order inside each aisle", () => {
    const groups = groupByShoppingCategory(
      ["2 cups flour", "1 onion", "1 cup milk", "2 carrots", "Parchment paper"],
      (text) => text
    );

    expect(groups).toEqual([
      { category: "produce", label: "Produce", items: ["1 onion", "2 carrots"] },
      { category: "dairy-eggs", label: "Dairy & Eggs", items: ["1 cup milk"] },
      { category: "baking", label: "Baking", items: ["2 cups flour"] },
      { category: "other", label: "Other", items: ["Parchment paper"] }
    ]);
  });
});
