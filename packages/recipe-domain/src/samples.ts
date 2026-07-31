import type { Recipe, RecipeConfidence } from "./index.js";

export type StarterRecipeSample = {
  id: `starter-${string}`;
  kind: "starter-recipe";
  label: "starter recipe";
  countsTowardQuota: false;
  recipe: Recipe;
};

export type StarterRecipeSeedRecord = {
  id: StarterRecipeSample["id"];
  isStarter: true;
  label: "Starter recipe";
  countsTowardQuota: false;
  fetchMode: "http";
  provenance: ["llm"];
  recipe: Recipe;
  savedAt: string;
  strategy: "llm-fallback";
  warnings: [];
};

const buildStarterConfidence = (summary: string): RecipeConfidence => ({
  score: 1,
  summary,
  missingFields: [],
  notes: ["Original LinkDish starter recipe content."],
  fieldProvenance: {
    title: "llm",
    ingredients: "llm",
    steps: "llm",
    servings: "llm",
    prepTimeMinutes: "llm",
    cookTimeMinutes: "llm",
    nutrition: null
  }
});

export const SAMPLE_RECIPES = [
  {
    id: "starter-ginger-sesame-chicken-rice-skillet",
    kind: "starter-recipe",
    label: "starter recipe",
    countsTowardQuota: false,
    recipe: {
      title: "Ginger-Sesame Chicken Rice Skillet",
      sourceUrl: "https://linkdish.ca/starter/ginger-sesame-chicken-rice-skillet",
      sourceType: "recipe-webpage",
      image: null,
      ingredients: [
        { section: "For the sauce", text: "3 tablespoons low-sodium soy sauce" },
        { section: "For the sauce", text: "1 tablespoon rice vinegar" },
        { section: "For the sauce", text: "1 tablespoon honey" },
        { section: "For the sauce", text: "2 teaspoons toasted sesame oil" },
        { section: "For the sauce", text: "2 teaspoons grated fresh ginger" },
        {
          section: "For the chicken",
          text: "1 pound boneless skinless chicken thighs, cut into bite-size pieces"
        },
        { section: "For the chicken", text: "1 tablespoon neutral oil" },
        { section: "For the chicken", text: "1 red bell pepper, thinly sliced" },
        { section: "For the chicken", text: "2 cups snap peas, strings removed" },
        { section: "For the chicken", text: "2 scallions, sliced" },
        { section: "For serving", text: "3 cups cooked jasmine rice" },
        { section: "For serving", text: "1 teaspoon toasted sesame seeds" }
      ],
      steps: [
        {
          index: 1,
          text: "Whisk the soy sauce, rice vinegar, honey, sesame oil, and ginger in a small bowl until the honey dissolves, about 1 minute."
        },
        {
          index: 2,
          text: "Heat the neutral oil in a large skillet over medium-high heat for 1 minute, then add the chicken in an even layer."
        },
        {
          index: 3,
          text: "Cook the chicken, stirring once or twice, until browned and nearly cooked through, 6-8 minutes."
        },
        {
          index: 4,
          text: "Add the bell pepper and snap peas and cook until the vegetables brighten and soften slightly, 3-4 minutes."
        },
        {
          index: 5,
          text: "Pour in the sauce and simmer, stirring, until glossy and lightly reduced, 2-3 minutes."
        },
        {
          index: 6,
          text: "Serve over warm rice and finish with scallions and sesame seeds."
        }
      ],
      servings: "4 servings",
      prepTimeMinutes: 10,
      cookTimeMinutes: 20,
      nutrition: null,
      confidence: buildStarterConfidence(
        "Original weeknight dinner starter recipe with complete timing and sectioned ingredients."
      )
    }
  },
  {
    id: "starter-brown-butter-berry-oat-bars",
    kind: "starter-recipe",
    label: "starter recipe",
    countsTowardQuota: false,
    recipe: {
      title: "Brown Butter Berry Oat Bars",
      sourceUrl: "https://linkdish.ca/starter/brown-butter-berry-oat-bars",
      sourceType: "recipe-webpage",
      image: null,
      ingredients: [
        { section: "For the oat base", text: "10 tablespoons unsalted butter" },
        { section: "For the oat base", text: "1 cup rolled oats" },
        { section: "For the oat base", text: "1 cup all-purpose flour" },
        { section: "For the oat base", text: "1/2 cup light brown sugar, packed" },
        { section: "For the oat base", text: "1/2 teaspoon baking powder" },
        { section: "For the oat base", text: "1/2 teaspoon fine sea salt" },
        { section: "For the filling", text: "1 1/2 cups mixed berries, fresh or frozen" },
        { section: "For the filling", text: "2 tablespoons granulated sugar" },
        { section: "For the filling", text: "1 tablespoon lemon juice" },
        { section: "For the filling", text: "2 teaspoons cornstarch" },
        { section: "For finishing", text: "1 tablespoon coarse sugar, optional" }
      ],
      steps: [
        {
          index: 1,
          text: "Heat the oven to 350 F and line an 8-inch square pan with parchment, leaving overhang on two sides."
        },
        {
          index: 2,
          text: "Melt the butter in a small saucepan over medium heat and cook, swirling often, until it smells nutty and brown specks form, 4-6 minutes."
        },
        {
          index: 3,
          text: "Stir the oats, flour, brown sugar, baking powder, and salt in a mixing bowl, then pour in the brown butter and mix until clumpy."
        },
        {
          index: 4,
          text: "Press about two-thirds of the oat mixture firmly into the pan and bake for 8 minutes to set the base."
        },
        {
          index: 5,
          text: "Toss the berries with granulated sugar, lemon juice, and cornstarch, then spread the fruit over the warm base."
        },
        {
          index: 6,
          text: "Crumble the remaining oat mixture over the fruit, sprinkle with coarse sugar if using, and bake 25-30 minutes, until bubbling at the edges."
        },
        {
          index: 7,
          text: "Cool in the pan for at least 30 minutes before lifting out and slicing into bars."
        }
      ],
      servings: "9 bars",
      prepTimeMinutes: 15,
      cookTimeMinutes: 38,
      nutrition: null,
      confidence: buildStarterConfidence(
        "Original baked starter recipe with prep time, cook time, and timer-friendly step durations."
      )
    }
  },
  {
    id: "starter-crisp-cucumber-chickpea-pitas",
    kind: "starter-recipe",
    label: "starter recipe",
    countsTowardQuota: false,
    recipe: {
      title: "Crisp Cucumber Chickpea Pitas",
      sourceUrl: "https://linkdish.ca/starter/crisp-cucumber-chickpea-pitas",
      sourceType: "recipe-webpage",
      image: null,
      ingredients: [
        { section: "For the filling", text: "1 can chickpeas, drained and rinsed" },
        { section: "For the filling", text: "1 Persian cucumber, diced" },
        { section: "For the filling", text: "1 cup cherry tomatoes, quartered" },
        { section: "For the filling", text: "1/4 cup crumbled feta" },
        { section: "For the dressing", text: "2 tablespoons plain Greek yogurt" },
        { section: "For the dressing", text: "1 tablespoon lemon juice" },
        { section: "For the dressing", text: "1 tablespoon olive oil" },
        { section: "For the dressing", text: "1 teaspoon chopped dill" },
        { section: "For serving", text: "2 pita pockets, halved" },
        { section: "For serving", text: "2 handfuls baby spinach" }
      ],
      steps: [
        {
          index: 1,
          text: "Whisk the yogurt, lemon juice, olive oil, dill, and a pinch of salt in a bowl until smooth, about 1 minute."
        },
        {
          index: 2,
          text: "Fold in the chickpeas, cucumber, tomatoes, and feta, then let the filling stand for 5 minutes so the flavors settle."
        },
        {
          index: 3,
          text: "Tuck spinach into each pita half, spoon in the chickpea filling, and serve right away."
        }
      ],
      servings: "4 pita halves",
      prepTimeMinutes: 12,
      cookTimeMinutes: 0,
      nutrition: null,
      confidence: buildStarterConfidence(
        "Original no-cook starter recipe with minimal steps and complete structured fields."
      )
    }
  }
] as const satisfies readonly StarterRecipeSample[];

export const createStarterRecipeSeedRecords = (
  savedAt = new Date().toISOString()
): StarterRecipeSeedRecord[] =>
  SAMPLE_RECIPES.map((sample) => ({
    id: sample.id,
    isStarter: true,
    label: "Starter recipe",
    countsTowardQuota: sample.countsTowardQuota,
    fetchMode: "http",
    provenance: ["llm"],
    recipe: sample.recipe,
    savedAt,
    strategy: "llm-fallback",
    warnings: []
  }));
