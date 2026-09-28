/**
 * Conservative automatic tags for a recipe: course, cuisine, cooking methods, vegetarian/vegan
 * and "quick". Every suggestion carries a human-readable reason, and a tag is only suggested on
 * a clear signal: a wrong "vegan" badge is worse than none. The dictionaries are module-level
 * word lists compiled once into word-boundary patterns.
 */
import { getRecipeTimes } from "./durations.js";

import type { Recipe } from "./recipe-schema.js";

export const RECIPE_COURSES = [
  "breakfast",
  "lunch",
  "dinner",
  "dessert",
  "snack",
  "side",
  "drink",
  "baking"
] as const;
export const RECIPE_CUISINES = [
  "italian",
  "mexican",
  "indian",
  "thai",
  "japanese",
  "chinese",
  "korean",
  "vietnamese",
  "french",
  "spanish",
  "mediterranean",
  "middle-eastern",
  "caribbean",
  "american"
] as const;
export const RECIPE_METHODS = [
  "one-pot",
  "sheet-pan",
  "slow-cooker",
  "instant-pot",
  "air-fryer",
  "grill",
  "no-bake",
  "bake"
] as const;
export const RECIPE_DIETS = ["vegetarian", "vegan"] as const;

export type RecipeCourse = (typeof RECIPE_COURSES)[number];
export type RecipeCuisine = (typeof RECIPE_CUISINES)[number];
export type RecipeMethod = (typeof RECIPE_METHODS)[number];
export type RecipeDiet = (typeof RECIPE_DIETS)[number];

export type TagSuggestion<Value extends string> = { value: Value; reason: string };

export type InferredRecipeTags = {
  course: TagSuggestion<RecipeCourse> | null;
  cuisine: TagSuggestion<RecipeCuisine> | null;
  method: Array<TagSuggestion<RecipeMethod>>;
  diet: Array<TagSuggestion<RecipeDiet>>;
  /** Total time of 30 minutes or less. */
  quick: TagSuggestion<"quick"> | null;
  /** Every suggested value, for filter chips: ["dinner", "italian", "one-pot", "quick"]. */
  tags: string[];
};

type TaggableRecipe = Pick<Recipe, "title" | "ingredients" | "steps"> &
  Partial<
    Pick<
      Recipe,
      | "prepTimeMinutes"
      | "cookTimeMinutes"
      | "totalTimeMinutes"
      | "category"
      | "cuisine"
      | "keywords"
      | "description"
    >
  >;

const DIACRITIC_PATTERN = /[̀-ͯ]/gu;

const fold = (text: string): string =>
  text.normalize("NFD").replace(DIACRITIC_PATTERN, "").toLowerCase();

const compileWords = (words: readonly string[]): RegExp =>
  new RegExp(String.raw`\b(?:${words.join("|")})\b`, "i");

// --- Course ------------------------------------------------------------------------------------

/** Words in the title (or category/keywords) that name a course, checked in this order. */
const COURSE_RULES: ReadonlyArray<{ course: RecipeCourse; pattern: RegExp }> = [
  {
    course: "drink",
    pattern: compileWords([
      "smoothies?",
      "cocktails?",
      "margaritas?",
      "mojitos?",
      "lemonade",
      "latte",
      "iced tea",
      "punch",
      "sangria",
      "milkshakes?",
      "hot chocolate",
      "spritz",
      "martinis?",
      "juice",
      "drinks?",
      "beverages?"
    ])
  },
  {
    course: "dessert",
    pattern: compileWords([
      "cakes?",
      "cupcakes?",
      "cheesecakes?",
      "cookies?",
      "brownies?",
      "blondies?",
      "(?<!pot |shepherd'?s |cottage |meat |chicken |pork )pies?",
      "tarts?",
      "(?<!yorkshire )puddings?",
      "ice cream",
      "sorbet",
      "gelato",
      "fudge",
      "mousse",
      "crumble",
      "cobbler",
      "truffles?",
      "macarons?",
      "tiramisu",
      "pavlova",
      "meringues?",
      "custard",
      "panna cotta",
      "doughnuts?",
      "donuts?",
      "churros?",
      "cannoli",
      "baklava",
      "desserts?",
      // "Sweets" or "sweet treats", not the adjective: "Sweet Potato Curry" and "Sweet and Sour
      // Pork" are dinners.
      "sweets",
      "sweet treats?"
    ])
  },
  {
    course: "breakfast",
    pattern: compileWords([
      "pancakes?",
      "waffles?",
      "french toast",
      "oatmeal",
      "porridge",
      "granola",
      "omelett?e",
      "frittata",
      "scrambled eggs",
      "breakfast",
      "brunch",
      "overnight oats",
      "hash browns",
      "shakshuka",
      "eggs benedict",
      "crepes?"
    ])
  },
  {
    course: "baking",
    pattern: compileWords([
      "bread",
      "loaf",
      "focaccia",
      "sourdough",
      "dinner rolls",
      "bread rolls",
      "buns",
      "biscuits",
      "scones?",
      "muffins?",
      "pizza dough",
      "pizza crust",
      "crust",
      "bagels?",
      "baguettes?",
      "brioche",
      "challah",
      "baking"
    ])
  },
  {
    course: "snack",
    pattern: compileWords([
      "snacks?",
      "dip",
      "hummus",
      "guacamole",
      "salsa",
      "popcorn",
      "energy bites",
      "crackers",
      "deviled eggs",
      "bruschetta",
      "appetizers?",
      "starters?",
      "nachos"
    ])
  },
  {
    course: "side",
    pattern: compileWords([
      "side",
      "sides",
      "slaw",
      "coleslaw",
      "mashed potatoes",
      "pilaf",
      "fries",
      "garlic bread",
      "cornbread",
      "roasted (?:vegetables|veggies|broccoli|carrots|potatoes|brussels sprouts|cauliflower|asparagus)"
    ])
  },
  {
    course: "lunch",
    pattern: compileWords([
      "sandwich(?:es)?",
      "wraps?",
      "pitas?",
      "paninis?",
      "grilled cheese",
      "lunch",
      "salads?",
      "toasties?",
      "bento"
    ])
  },
  {
    course: "dinner",
    pattern: compileWords([
      "dinner",
      "main",
      "entree",
      "skillet",
      "stir[- ]?fry",
      "curry",
      "stew",
      "casserole",
      "roast",
      "tacos?",
      "pasta",
      "spaghetti",
      "lasagna",
      "chili",
      "burgers?",
      "meatballs",
      "enchiladas?",
      "risotto",
      "paella",
      "ramen",
      "noodles",
      "fajitas",
      "pot pie",
      "shepherd'?s pie",
      "ribs",
      "steak",
      "chops",
      "bowls?",
      "tagine",
      "biryani",
      "gnocchi",
      "fried rice"
    ])
  }
];

/** schema.org recipeCategory values → course. */
const CATEGORY_COURSE_RULES: ReadonlyArray<{ course: RecipeCourse; pattern: RegExp }> = [
  { course: "dessert", pattern: compileWords(["desserts?", "sweets?", "cakes?", "cookies?"]) },
  { course: "breakfast", pattern: compileWords(["breakfast", "brunch"]) },
  { course: "drink", pattern: compileWords(["drinks?", "beverages?", "cocktails?", "smoothies?"]) },
  { course: "side", pattern: compileWords(["sides?", "side dish(?:es)?"]) },
  { course: "snack", pattern: compileWords(["snacks?", "appetizers?", "starters?"]) },
  { course: "baking", pattern: compileWords(["breads?", "baking", "baked goods"]) },
  { course: "lunch", pattern: compileWords(["lunch", "sandwich(?:es)?", "salads?"]) },
  {
    course: "dinner",
    pattern: compileWords(["dinner", "main(?: course| dish)?s?", "entrees?", "supper"])
  }
];

/** "Bars" are dessert only when something sweet is in them ("berry oat bars", not "granola bars"). */
const BARS_PATTERN = /\bbars\b/i;
const SWEET_INGREDIENT_PATTERN = /\b(?:sugar|honey|maple syrup|chocolate|caramel|jam)\b/i;

const inferCourse = (
  recipe: TaggableRecipe,
  ingredientText: string
): TagSuggestion<RecipeCourse> | null => {
  const category = recipe.category ?? "";

  for (const { course, pattern } of CATEGORY_COURSE_RULES) {
    if (category && pattern.test(fold(category))) {
      return { value: course, reason: `Recipe category is "${category}"` };
    }
  }

  const title = fold(recipe.title);
  const keywords = fold((recipe.keywords ?? []).join(", "));

  for (const { course, pattern } of COURSE_RULES) {
    const match = pattern.exec(title) ?? pattern.exec(keywords);

    if (match) {
      return {
        value: course,
        reason: `"${match[0]}" in the ${pattern.test(title) ? "title" : "keywords"}`
      };
    }

    if (
      course === "dessert" &&
      BARS_PATTERN.test(title) &&
      SWEET_INGREDIENT_PATTERN.test(ingredientText)
    ) {
      return { value: "dessert", reason: '"bars" in the title with sweet ingredients' };
    }
  }

  return null;
};

// --- Cuisine -----------------------------------------------------------------------------------

/** Signature words per cuisine. Title/keyword hits count 3, ingredient hits 1. */
const CUISINE_WORDS: Readonly<Record<RecipeCuisine, readonly string[]>> = {
  italian: [
    "italian",
    "spaghetti",
    "penne",
    "linguine",
    "fettuccine",
    "rigatoni",
    "lasagna",
    "gnocchi",
    "risotto",
    "ravioli",
    "tortellini",
    "carbonara",
    "bolognese",
    "parmesan",
    "parmigiano",
    "pecorino",
    "mozzarella",
    "ricotta",
    "mascarpone",
    "pesto",
    "marinara",
    "prosciutto",
    "pancetta",
    "bruschetta",
    "focaccia",
    "tiramisu",
    "polenta",
    "arancini",
    "caprese",
    "pizza",
    "calzone",
    "cacio e pepe",
    "amatriciana",
    "italian sausage"
  ],
  mexican: [
    "mexican",
    "tacos?",
    "burritos?",
    "enchiladas?",
    "quesadillas?",
    "tortillas?",
    "salsa",
    "guacamole",
    "jalapenos?",
    "chipotles?",
    "cotija",
    "queso",
    "tamales?",
    "pozole",
    "mole",
    "fajitas?",
    "elote",
    "carnitas",
    "al pastor",
    "tostadas?",
    "refried beans",
    "pico de gallo",
    "masa",
    "poblano",
    "ancho"
  ],
  indian: [
    "indian",
    "garam masala",
    "masala",
    "turmeric",
    "cardamom",
    "ghee",
    "paneer",
    "tikka",
    "dal",
    "dhal",
    "naan",
    "biryani",
    "samosas?",
    "chutney",
    "tandoori",
    "korma",
    "vindaloo",
    "chana",
    "aloo",
    "raita",
    "basmati",
    "curry leaves",
    "fenugreek"
  ],
  thai: [
    "thai",
    "fish sauce",
    "lemongrass",
    "thai basil",
    "galangal",
    "kaffir lime",
    "makrut",
    "pad thai",
    "tom yum",
    "green curry",
    "red curry",
    "curry paste",
    "satay",
    "sriracha",
    "palm sugar"
  ],
  japanese: [
    "japanese",
    "miso",
    "mirin",
    "sake",
    "dashi",
    "nori",
    "sushi",
    "teriyaki",
    "ramen",
    "udon",
    "soba",
    "tempura",
    "katsu",
    "wasabi",
    "edamame",
    "yakitori",
    "matcha",
    "furikake",
    "ponzu",
    "bonito",
    "soy sauce",
    "rice vinegar"
  ],
  chinese: [
    "chinese",
    "hoisin",
    "oyster sauce",
    "shaoxing",
    "five[- ]spice",
    "sichuan",
    "szechuan",
    "bok choy",
    "wontons?",
    "fried rice",
    "lo mein",
    "chow mein",
    "kung pao",
    "mapo",
    "char siu",
    "star anise",
    "black bean sauce",
    "doubanjiang",
    "soy sauce",
    "rice vinegar"
  ],
  korean: [
    "korean",
    "gochujang",
    "gochugaru",
    "kimchi",
    "bulgogi",
    "bibimbap",
    "doenjang",
    "japchae",
    "galbi",
    "tteok"
  ],
  vietnamese: ["vietnamese", "pho", "banh mi", "nuoc cham", "rice paper", "vermicelli"],
  french: [
    "french",
    "creme fraiche",
    "gruyere",
    "dijon",
    "bechamel",
    "coq au vin",
    "ratatouille",
    "bourguignon",
    "crepes?",
    "souffle",
    "quiche",
    "croissants?",
    "gratin",
    "nicoise",
    "tarragon",
    "herbes de provence",
    "confit",
    "madeleines?",
    "eclairs?",
    "creme brulee",
    "brioche"
  ],
  spanish: [
    "spanish",
    "paella",
    "chorizo",
    "tapas",
    "gazpacho",
    "patatas bravas",
    "manchego",
    "saffron",
    "romesco"
  ],
  mediterranean: [
    "mediterranean",
    "greek",
    "feta",
    "kalamata",
    "olives?",
    "tzatziki",
    "souvlaki",
    "gyros?",
    "spanakopita",
    "moussaka",
    "orzo",
    "greek yogurt",
    "pitas?",
    "chickpeas?"
  ],
  "middle-eastern": [
    "middle eastern",
    "lebanese",
    "persian",
    "israeli",
    "turkish",
    "tahini",
    "za'?atar",
    "sumac",
    "hummus",
    "falafel",
    "shawarma",
    "pomegranate molasses",
    "harissa",
    "baba ganoush",
    "tabbouleh",
    "labneh",
    "halloumi",
    "kebabs?",
    "shakshuka",
    "dukkah",
    "freekeh",
    "bulgur",
    "pitas?",
    "chickpeas?"
  ],
  caribbean: ["caribbean", "jamaican", "jerk", "plantains?", "scotch bonnet", "callaloo"],
  american: [
    "american",
    "bbq",
    "barbecue",
    "burgers?",
    "mac and cheese",
    "meatloaf",
    "sloppy joes?",
    "cornbread",
    "biscuits and gravy",
    "pot roast",
    "buffalo",
    "chocolate chip cookies",
    "grits",
    "southern",
    "cajun",
    "jambalaya"
  ]
};

const CUISINE_PATTERNS: ReadonlyArray<{
  cuisine: RecipeCuisine;
  words: ReadonlyArray<{ word: string; pattern: RegExp }>;
}> = RECIPE_CUISINES.map((cuisine) => ({
  cuisine,
  words: CUISINE_WORDS[cuisine].map((word) => ({ word, pattern: compileWords([word]) }))
}));

const CUISINE_NAME_PATTERNS: ReadonlyMap<RecipeCuisine, RegExp> = new Map(
  RECIPE_CUISINES.map((cuisine) => [
    cuisine,
    compileWords([
      cuisine.replace("-", "[- ]"),
      ...(cuisine === "mediterranean" ? ["greek"] : []),
      ...(cuisine === "middle-eastern" ? ["lebanese", "persian", "israeli", "turkish"] : []),
      ...(cuisine === "american" ? ["southern", "cajun", "tex[- ]mex"] : [])
    ])
  ])
);

/** Matches nothing; every cuisine has a name pattern, so this is only a type-level fallback. */
const NEVER_MATCHES_PATTERN = /(?!)/u;

const compileCuisineName = (cuisine: RecipeCuisine): RegExp =>
  CUISINE_NAME_PATTERNS.get(cuisine) ?? NEVER_MATCHES_PATTERN;

const TITLE_WEIGHT = 3;
const INGREDIENT_WEIGHT = 1;
const CUISINE_MIN_SCORE = 3;
const CUISINE_MIN_MARGIN = 2;

const inferCuisine = (
  recipe: TaggableRecipe,
  ingredientText: string
): TagSuggestion<RecipeCuisine> | null => {
  const declared = recipe.cuisine ? fold(recipe.cuisine) : "";

  if (declared) {
    const match = CUISINE_PATTERNS.find(({ cuisine }) =>
      compileCuisineName(cuisine).test(declared)
    );

    if (match) {
      return { value: match.cuisine, reason: `Recipe cuisine is "${recipe.cuisine}"` };
    }
  }

  const title = fold([recipe.title, ...(recipe.keywords ?? [])].join(" · "));
  const ingredients = fold(ingredientText);
  const scored = CUISINE_PATTERNS.map(({ cuisine, words }) => {
    let score = 0;
    const hits: string[] = [];

    for (const { pattern } of words) {
      const titleHit = pattern.exec(title);
      const ingredientHit = titleHit ? null : pattern.exec(ingredients);

      if (titleHit) {
        score += TITLE_WEIGHT;
        hits.push(titleHit[0]);
      } else if (ingredientHit) {
        score += INGREDIENT_WEIGHT;
        hits.push(ingredientHit[0]);
      }
    }

    return { cuisine, score, hits };
  }).sort((left, right) => right.score - left.score);

  const [best, second] = scored;

  if (
    !best ||
    best.score < CUISINE_MIN_SCORE ||
    best.score - (second?.score ?? 0) < CUISINE_MIN_MARGIN
  ) {
    return null;
  }

  return {
    value: best.cuisine,
    reason: `Signature ingredients or dishes: ${best.hits.slice(0, 4).join(", ")}`
  };
};

// --- Methods -----------------------------------------------------------------------------------

const SLOW_COOKER_PATTERN = /\b(?:slow[- ]cooker|crock[- ]?pot|slow cook(?:ed|ing)?)\b/i;
const INSTANT_POT_PATTERN =
  /\b(?:instant pot|pressure[- ]cook(?:er|ed|ing)?|multicooker|multi-cooker)\b/i;
const AIR_FRYER_PATTERN = /\bair[- ]?fr(?:y|yer|ied|ying)\b/i;
const SHEET_PAN_PATTERN = /\bsheet[- ](?:pan|tray)\b/i;
const GRILL_TITLE_PATTERN = /\bgrill(?:ed|ing)?\b/i;
const GRILL_STEP_PATTERN =
  /\b(?:(?:pre)?heat (?:a|the|your) (?:grill|barbecue|bbq)|on the grill|over (?:hot |medium |high |direct |indirect )?(?:coals|grill)|grill (?:for|until|over|the)|grill grates)\b/i;
const ONE_POT_TITLE_PATTERN = /\b(?:one[- ](?:pot|pan|skillet)|single[- ]pot)\b/i;
const SKILLET_TITLE_PATTERN = /\bskillet\b/i;
const NO_BAKE_TITLE_PATTERN = /\bno[- ]bake\b/i;
const OVEN_PATTERN = /\b(?:bake[ds]?|oven|roast(?:ed|ing)?|broil(?:ed|ing)?)\b/i;
const HEAT_PATTERN =
  /\b(?:bake[ds]?|oven|roast|broil|fry|fried|saute|sear|simmer|boil|grill|microwave|toast|cook|heat|melt(?:ed)?)\b/i;
const CHILL_PATTERN = /\b(?:refrigerat\w*|chill\w*|freez\w*|set in the fridge|fridge)\b/i;
const SENTENCE_SPLIT_PATTERN = /(?<=[.!?])\s+|\n+/u;
const ALTERNATIVE_SENTENCE_PATTERN =
  /\b(?:alternately|alternatively|optionally|if you (?:prefer|like|have|want)|you (?:can|could) also|or you can|instead of)\b/i;
const VESSEL_PATTERN =
  /\b(?:skillet|saucepan|stockpot|dutch oven|wok|pot|frying pan|baking dish|sheet pan|roasting pan)\b/gi;

const inferMethods = (
  recipe: TaggableRecipe,
  stepText: string,
  course: RecipeCourse | null
): Array<TagSuggestion<RecipeMethod>> => {
  const title = fold([recipe.title, ...(recipe.keywords ?? [])].join(" · "));
  // "Alternately, you can grill the ribs": an optional method is not how the recipe cooks.
  const steps = fold(stepText)
    .split(SENTENCE_SPLIT_PATTERN)
    .filter((sentence) => !ALTERNATIVE_SENTENCE_PATTERN.test(sentence))
    .join(" ");
  const methods: Array<TagSuggestion<RecipeMethod>> = [];
  const add = (value: RecipeMethod, reason: string) => methods.push({ value, reason });
  const either = (pattern: RegExp) => pattern.test(title) || pattern.test(steps);

  if (either(SLOW_COOKER_PATTERN)) {
    add("slow-cooker", "Uses a slow cooker");
  }

  if (either(INSTANT_POT_PATTERN)) {
    add("instant-pot", "Uses a pressure cooker");
  }

  if (either(AIR_FRYER_PATTERN)) {
    add("air-fryer", "Uses an air fryer");
  }

  if (either(SHEET_PAN_PATTERN)) {
    add("sheet-pan", "Cooked on a sheet pan");
  }

  if (GRILL_TITLE_PATTERN.test(title) || GRILL_STEP_PATTERN.test(steps)) {
    add("grill", "Cooked on the grill");
  }

  const vessels = new Set(
    (steps.match(VESSEL_PATTERN) ?? []).map((vessel) => vessel.toLowerCase())
  );

  if (ONE_POT_TITLE_PATTERN.test(title)) {
    add("one-pot", "One pot or pan in the title");
  } else if (SKILLET_TITLE_PATTERN.test(title) && vessels.size <= 1 && !OVEN_PATTERN.test(steps)) {
    add("one-pot", "Cooked start to finish in one skillet");
  }

  const cooksWithHeat = HEAT_PATTERN.test(steps);

  if (
    NO_BAKE_TITLE_PATTERN.test(title) ||
    ((course === "dessert" || course === "snack") && !cooksWithHeat && CHILL_PATTERN.test(steps))
  ) {
    add("no-bake", "Sets in the fridge instead of the oven");
  } else if (OVEN_PATTERN.test(steps) && !methods.some((method) => method.value === "air-fryer")) {
    add("bake", "Cooked in the oven");
  }

  return methods;
};

// --- Diet --------------------------------------------------------------------------------------

const MEAT_WORDS = [
  "chicken",
  "beef",
  "pork",
  "bacon",
  "ham",
  "sausages?",
  "turkey",
  "lamb",
  "mutton",
  "veal",
  "duck",
  "goose",
  "venison",
  "bison",
  "rabbit",
  "(?<!(?:cauliflower|tofu|mushroom|cabbage|portobello|celeriac) )steaks?",
  "(?<!celery )ribs",
  "brisket",
  "meat",
  "meatballs?",
  "mince",
  "prosciutto",
  "pancetta",
  "salami",
  "pepperoni",
  "chorizo",
  "guanciale",
  "lard",
  "suet",
  "gelatine?",
  "marshmallows?",
  "bone broth",
  "fish",
  "salmon",
  "tuna",
  "cod",
  "halibut",
  "tilapia",
  "trout",
  "sardines?",
  "anchov(?:y|ies)",
  "shrimp",
  "prawns?",
  "crab",
  "lobster",
  "clams?",
  "mussels",
  "oysters?(?! mushrooms?)",
  "scallops?",
  "squid",
  "calamari",
  "octopus",
  "worcestershire",
  "bonito",
  "dashi",
  // A broth that does not say it is vegetable is usually chicken or beef.
  "(?<!vegetable |veggie |mushroom |vegan )(?:broth|stock)"
];
const MEAT_PATTERN = new RegExp(
  String.raw`(?<!\b(?:vegan|vegetarian|plant[- ]based|meatless|veggie|beyond|impossible|mock|faux) )\b(?:${MEAT_WORDS.join("|")})\b`,
  "i"
);
const ANIMAL_PRODUCT_WORDS = [
  "(?<!(?:coconut|almond|oat|soy|rice|cashew|hemp|plant|vegan) )milk",
  "buttermilk",
  "(?<!(?:peanut|almond|cashew|nut|seed|sunflower|cocoa|apple|shea|vegan) )butter",
  "(?<!(?:vegan|plant[- ]based|cashew) )cheeses?",
  "cheddar",
  "mozzarella",
  "parmesan",
  "parmigiano",
  "pecorino",
  "feta",
  "ricotta",
  "mascarpone",
  "gruyere",
  "brie",
  "halloumi",
  "paneer",
  "cotija",
  "queso",
  "(?<!(?:coconut|vegan|cashew|oat) )cream(?! of tartar)",
  "sour cream",
  "creme fraiche",
  "(?<!(?:coconut|soy|vegan|plant[- ]based|oat|almond) )yogh?urt",
  "ghee",
  "whey",
  "casein",
  "ice cream",
  "eggs?",
  "egg (?:whites?|yolks?)",
  "yolks?",
  "honey",
  "(?<!vegan )mayo(?:nnaise)?",
  "aioli",
  "custard",
  // Usually made with milk solids; the reason text already says to check labels.
  "chocolate chips",
  "chocolate chunks",
  "milk chocolate",
  "white chocolate"
];
const ANIMAL_PRODUCT_PATTERN = new RegExp(
  String.raw`\b(?:${ANIMAL_PRODUCT_WORDS.join("|")})\b`,
  "i"
);

const inferDiet = (ingredientLines: readonly string[]): Array<TagSuggestion<RecipeDiet>> => {
  if (ingredientLines.length === 0) {
    return [];
  }

  const folded = ingredientLines.map(fold);

  if (folded.some((line) => MEAT_PATTERN.test(line))) {
    return [];
  }

  const count = ingredientLines.length;
  const diet: Array<TagSuggestion<RecipeDiet>> = [
    {
      value: "vegetarian",
      reason: `No meat or fish in ${count} ingredient${count === 1 ? "" : "s"}; check labels`
    }
  ];

  if (!folded.some((line) => ANIMAL_PRODUCT_PATTERN.test(line))) {
    diet.push({ value: "vegan", reason: "No meat, fish, dairy, eggs or honey; check labels" });
  }

  return diet;
};

// --- Public API --------------------------------------------------------------------------------

const QUICK_MAX_MINUTES = 30;

/**
 * Suggests tags for a recipe. Conservative by design: the course comes from the recipe's own
 * category or a clear title word; a cuisine needs several signature words and a clear lead;
 * "vegetarian" needs ingredients and none of them meat or fish; "vegan" additionally no dairy,
 * eggs or honey; "quick" needs a known total time of 30 minutes or less.
 */
export const inferRecipeTags = (recipe: TaggableRecipe): InferredRecipeTags => {
  const ingredientLines = recipe.ingredients.map((ingredient) => ingredient.text);
  const ingredientText = ingredientLines.join("\n");
  const stepText = recipe.steps.map((step) => step.text).join("\n");
  const course = inferCourse(recipe, ingredientText);
  const cuisine = inferCuisine(recipe, ingredientText);
  const method = inferMethods(recipe, stepText, course?.value ?? null);
  const diet = inferDiet(ingredientLines);
  const total = getRecipeTimes(recipe).total;
  const quick =
    total != null && total > 0 && total <= QUICK_MAX_MINUTES
      ? { value: "quick" as const, reason: `Ready in ${total} min` }
      : null;

  return {
    course,
    cuisine,
    method,
    diet,
    quick,
    tags: [
      ...(course ? [course.value] : []),
      ...(cuisine ? [cuisine.value] : []),
      ...method.map((entry) => entry.value),
      ...diet.map((entry) => entry.value),
      ...(quick ? [quick.value] : [])
    ]
  };
};
