/**
 * Grocery aisles for shopping lists. The category is computed at render time from the item text
 * (the ShoppingItem contract has no category field), so the rules here must be deterministic
 * and cheap: one ordered list of precompiled word-boundary patterns, first match wins.
 */
import { parseIngredientQuantity } from "./ingredient-quantities.js";
import { replaceBracketedGroups } from "./text-scan.js";

import type { BracketPair } from "./text-scan.js";

export const SHOPPING_CATEGORY_IDS = [
  "produce",
  "meat-seafood",
  "dairy-eggs",
  "bakery",
  "pantry",
  "baking",
  "spices",
  "canned",
  "condiments",
  "frozen",
  "beverages",
  "other"
] as const;

export type ShoppingCategoryId = (typeof SHOPPING_CATEGORY_IDS)[number];

/** Aisle order with display labels, in the order a typical store walk visits them. */
export const SHOPPING_CATEGORIES: ReadonlyArray<{ id: ShoppingCategoryId; label: string }> = [
  { id: "produce", label: "Produce" },
  { id: "meat-seafood", label: "Meat & Seafood" },
  { id: "dairy-eggs", label: "Dairy & Eggs" },
  { id: "bakery", label: "Bakery" },
  { id: "pantry", label: "Pantry" },
  { id: "baking", label: "Baking" },
  { id: "spices", label: "Spices & Seasonings" },
  { id: "canned", label: "Canned & Jarred" },
  { id: "condiments", label: "Condiments & Sauces" },
  { id: "frozen", label: "Frozen" },
  { id: "beverages", label: "Beverages" },
  { id: "other", label: "Other" }
];

const words = (list: readonly string[]): string => list.join("|");

const rule = (category: ShoppingCategoryId, alternatives: readonly string[]) => ({
  category,
  pattern: new RegExp(String.raw`\b(?:${words(alternatives)})\b`, "i")
});

const MEATS = [
  "chicken",
  "beef",
  "pork",
  "bacon",
  "pancetta",
  "prosciutto",
  "sausages?",
  "chorizo",
  "ham",
  "turkey",
  "lamb",
  "veal",
  "duck",
  "steaks?",
  "brisket",
  "ribs",
  "short ribs",
  "pork chops?",
  "tenderloin",
  "sirloin",
  "salami",
  "pepperoni",
  "meatballs?",
  "venison",
  "shrimp",
  "prawns?",
  "salmon",
  "cod",
  "halibut",
  "tilapia",
  "trout",
  "haddock",
  "snapper",
  "sea bass",
  "mahi[- ]mahi",
  "scallops?",
  "crab",
  "lobster",
  "clams?",
  "mussels",
  "oysters",
  "squid",
  "calamari",
  "octopus",
  "fish",
  "fillets?"
];

const DAIRY = [
  "milk",
  "buttermilk",
  "cream",
  "half[- ]and[- ]half",
  "butter",
  "margarine",
  "ghee",
  "cheese",
  "cheddar",
  "mozzarella",
  "parmesan",
  "parmigiano(?:[- ]reggiano)?",
  "pecorino",
  "feta",
  "ricotta",
  "mascarpone",
  "gouda",
  "gruy[eè]re",
  "brie",
  "halloumi",
  "paneer",
  "cotija",
  "queso fresco",
  "yogh?urt",
  "kefir",
  "cr[eè]me fra[iî]che",
  "eggs?",
  "egg whites?",
  "egg yolks?",
  "yolks?"
];

const PRODUCE = [
  "apples?",
  "bananas?",
  "berries",
  "strawberr(?:y|ies)",
  "blueberr(?:y|ies)",
  "raspberr(?:y|ies)",
  "blackberr(?:y|ies)",
  "cranberr(?:y|ies)",
  "cherr(?:y|ies)",
  "grapes?",
  "lemons?",
  "limes?",
  "oranges?",
  "clementines?",
  "grapefruits?",
  "avocados?",
  "tomato(?:es)?",
  "onions?",
  "shallots?",
  "scallions?",
  "leeks?",
  "garlic",
  "ginger",
  "potato(?:es)?",
  "yams?",
  "carrots?",
  "celery",
  "cucumbers?",
  "zucchini",
  "courgettes?",
  "squash",
  "pumpkins?",
  "lettuce",
  "romaine",
  "spinach",
  "kale",
  "arugula",
  "rocket",
  "chard",
  "cabbage",
  "bok choy",
  "broccoli",
  "broccolini",
  "cauliflower",
  "brussels sprouts?",
  "sprouts",
  "peppers",
  "jalape[nñ]os?",
  "serranos?",
  "habaneros?",
  "poblanos?",
  "chil(?:i|e|li)(?:es|s)?",
  "mushrooms?",
  "asparagus",
  "eggplants?",
  "aubergines?",
  "beets?",
  "beetroot",
  "radish(?:es)?",
  "turnips?",
  "parsnips?",
  "fennel",
  "artichokes?",
  "okra",
  "corn",
  "peas",
  "edamame",
  "sprouts?",
  "herbs",
  "basil",
  "parsley",
  "cilantro",
  "coriander leaves",
  "mint",
  "dill",
  "chives",
  "lemongrass",
  "peach(?:es)?",
  "nectarines?",
  "pears?",
  "plums?",
  "mangoe?s?",
  "pineapples?",
  "melons?",
  "watermelon",
  "cantaloupe",
  "kiwis?",
  "pomegranates?",
  "figs?",
  "papayas?",
  "rhubarb",
  "tofu",
  "tempeh",
  "salad greens",
  "greens",
  "microgreens",
  "watercress",
  "endive",
  "radicchio",
  "jicama",
  "plantains?"
];

const SPICES = [
  "salt",
  "pepper",
  "peppercorns?",
  "cumin",
  "paprika",
  "cinnamon",
  "nutmeg",
  "cloves",
  "allspice",
  "cardamom",
  "turmeric",
  "coriander",
  "cayenne",
  "curry powder",
  "garam masala",
  "chili powder",
  "chile powder",
  "chipotle powder",
  "oregano",
  "thyme",
  "rosemary",
  "sage",
  "tarragon",
  "marjoram",
  "bay leaf",
  "bay leaves",
  "saffron",
  "sumac",
  "za'?atar",
  "seasoning",
  "spice",
  "spices",
  "five[- ]spice",
  "herbes de provence",
  "mustard seeds?",
  "fennel seeds?",
  "caraway",
  "star anise",
  "msg"
];

const BAKERY = [
  "bread",
  "baguettes?",
  "loaf",
  "rolls?",
  "buns?",
  "brioche",
  "ciabatta",
  "sourdough",
  "tortillas?",
  "pitas?",
  "pita pockets?",
  "naan",
  "flatbreads?",
  "croissants?",
  "bagels?",
  "english muffins?",
  "pizza dough",
  "pie crusts?",
  "pie shells?",
  "crumpets?"
];

const BAKING = [
  "flour",
  "sugar",
  "baking soda",
  "baking powder",
  "bicarbonate of soda",
  "yeast",
  "vanilla",
  "extract",
  "cocoa",
  "chocolate",
  "cornstarch",
  "corn starch",
  "cornflour",
  "cornmeal",
  "polenta",
  "shortening",
  "sprinkles",
  "food colou?ring",
  "gelatin",
  "cream of tartar",
  "molasses",
  "corn syrup",
  "golden syrup",
  "marshmallows?",
  "coconut",
  "almond flour",
  "almond meal",
  "graham crackers?",
  "condensed milk"
];

const CONDIMENTS = [
  "ketchup",
  "mustard",
  "mayo(?:nnaise)?",
  "hot sauce",
  "sriracha",
  "soy sauce",
  "tamari",
  "fish sauce",
  "oyster sauce",
  "hoisin",
  "worcestershire",
  "bbq sauce",
  "barbecue sauce",
  "teriyaki",
  "salsa",
  "vinegar",
  "relish",
  "pesto",
  "jam",
  "jelly",
  "marmalade",
  "preserves",
  "pickles?",
  "olives?",
  "capers",
  "chutney",
  "gochujang",
  "miso",
  "harissa",
  "sambal",
  "chili crisp",
  "chili oil",
  "salad dressing",
  "dressing",
  "horseradish",
  "tahini",
  "tzatziki",
  "hummus",
  "aioli",
  "sauce"
];

const CANNED = [
  "canned",
  "tinned",
  "coconut milk",
  "coconut cream",
  "tomato paste",
  "tomato sauce",
  "tomato puree",
  "passata",
  "diced tomatoes",
  "crushed tomatoes",
  "whole peeled tomatoes",
  "stewed tomatoes",
  "fire[- ]roasted tomatoes",
  "sun[- ]dried tomatoes",
  "evaporated milk",
  "black beans",
  "kidney beans",
  "pinto beans",
  "cannellini beans",
  "navy beans",
  "white beans",
  "great northern beans",
  "refried beans",
  "baked beans",
  "butter beans",
  "beans",
  "chickpeas",
  "garbanzo beans",
  "lentils",
  "broth",
  "stock",
  "bouillon",
  "tuna",
  "sardines",
  "anchovies",
  "anchovy",
  "pumpkin pur[eé]e",
  "enchilada sauce",
  "marinara",
  "pasta sauce",
  "chipotles? in adobo",
  "green chiles",
  "water chestnuts",
  "bamboo shoots",
  "artichoke hearts",
  "roasted red peppers"
];

const PANTRY = [
  "rice",
  "pasta",
  "spaghetti",
  "penne",
  "fusilli",
  "rigatoni",
  "linguine",
  "fettuccine",
  "macaroni",
  "orzo",
  "lasagna",
  "noodles",
  "ramen",
  "udon",
  "soba",
  "couscous",
  "quinoa",
  "bulgur",
  "farro",
  "barley",
  "oats",
  "oatmeal",
  "granola",
  "cereal",
  "crackers",
  "chips",
  "breadcrumbs",
  "bread crumbs",
  "panko",
  "croutons",
  "oil",
  "olive oil",
  "cooking spray",
  "honey",
  "maple syrup",
  "agave",
  "peanut butter",
  "almond butter",
  "nut butter",
  "nuts",
  "almonds",
  "walnuts",
  "pecans",
  "cashews",
  "pistachios",
  "peanuts",
  "hazelnuts",
  "pine nuts",
  "seeds",
  "sesame seeds",
  "chia seeds",
  "flax(?:seeds?)?",
  "sunflower seeds",
  "pepitas",
  "raisins",
  "dried fruit",
  "dates",
  "prunes",
  "dried (?:cranberries|apricots|cherries|figs|mango|blueberries)",
  "tortilla chips",
  "popcorn",
  "cornflakes",
  "rice cakes",
  "wonton wrappers",
  "rice paper",
  "nori",
  "seaweed"
];

const BEVERAGES = [
  "wine",
  "beer",
  "cider",
  "coffee",
  "espresso",
  "tea",
  "juice",
  "orange juice",
  "apple juice",
  "soda",
  "club soda",
  "sparkling water",
  "mineral water",
  "tonic(?: water)?",
  "ginger ale",
  "kombucha",
  "vodka",
  "rum",
  "gin",
  "tequila",
  "whiske?y",
  "bourbon",
  "brandy",
  "cognac",
  "vermouth",
  "sake",
  "mirin",
  "prosecco",
  "champagne",
  "liqueur",
  "bitters"
];

/**
 * Ordered rules, first match wins. Specific phrases come before the single words they contain
 * ("peanut butter" before "butter", "chicken broth" before "chicken", "red pepper flakes" before
 * "red peppers"), and cues that change the aisle ("frozen", "canned", "dried oregano") come first.
 */
const CATEGORY_RULES: ReadonlyArray<{ category: ShoppingCategoryId; pattern: RegExp }> = [
  rule("frozen", [
    "frozen",
    "ice cream",
    "gelato",
    "sorbet",
    "ice cubes?",
    String.raw`ice(?!\s+water)`,
    "puff pastry",
    "phyllo",
    "filo",
    "tater tots"
  ]),
  rule("beverages", [
    "orange juice",
    "apple juice",
    "cranberry juice",
    "coffee beans",
    "club soda",
    "sparkling water",
    "mineral water",
    "coconut water",
    "tonic water",
    "ginger ale",
    "(?:red|white|rosé|rose|dry|sparkling) wine(?!\\s+vinegar)",
    "dry sherry"
  ]),
  // Tap water is never bought; it gets its own bucket so "hide staples" can drop it.
  rule("other", [
    String.raw`(?:ice |hot |warm |cold |boiling |lukewarm |tap |filtered )?water(?!\s*chestnuts?)`
  ]),
  rule("canned", [
    "(?:chicken|beef|vegetable|veggie|bone|fish|turkey|mushroom|seafood) (?:broth|stock)",
    "broth",
    "stock",
    "bouillon",
    "stock cubes?",
    "anchovy fillets",
    "cream of (?:mushroom|chicken|celery) soup",
    "marinara(?: sauce)?",
    "pasta sauce",
    "enchilada sauce",
    "soup"
  ]),
  rule("spices", [
    "red pepper flakes",
    "crushed red pepper",
    "chil(?:i|e) flakes",
    "black pepper",
    "white pepper",
    "cayenne pepper",
    "lemon pepper",
    "garlic powder",
    "garlic salt",
    "onion powder",
    "ground (?:ginger|cloves|cinnamon|nutmeg|cumin|coriander|cardamom|allspice|turmeric|mustard)",
    "ground (?:red |black |white )?pepper",
    "dried (?:basil|parsley|oregano|thyme|rosemary|dill|sage|tarragon|mint|chives|marjoram|herbs)",
    "italian seasoning",
    "taco seasoning",
    "old bay",
    "smoked paprika",
    "kosher salt",
    "sea salt",
    "table salt",
    "flaky salt"
  ]),
  rule(
    "canned",
    CANNED.filter((entry) => entry.includes(" ") || entry === "canned" || entry === "tinned")
  ),
  rule("baking", [
    "baking soda",
    "baking powder",
    "(?:bread|cake|pastry|whole[- ]wheat|all[- ]purpose|self[- ]rais(?:ing|ed)|rye|spelt|plain|strong) flour",
    "(?:lemon|orange|almond|peppermint|vanilla|coconut|maple|rum) extract",
    "brown sugar",
    "powdered sugar",
    "confectioners'? sugar",
    "icing sugar",
    "caster sugar",
    "vanilla extract",
    "vanilla bean",
    "almond extract",
    "chocolate chips",
    "cocoa powder",
    "cream of tartar",
    "almond flour",
    "coconut flour",
    "corn syrup",
    "sweetened condensed milk",
    "condensed milk",
    "shredded coconut",
    "coconut flakes"
  ]),
  rule("dairy-eggs", [
    "cream cheese",
    "sour cream",
    "heavy cream",
    "whipping cream",
    "double cream",
    "single cream",
    "half[- ]and[- ]half",
    "buttermilk",
    "almond milk",
    "oat milk",
    "soy milk",
    "goat cheese",
    "cottage cheese",
    "whipped cream"
  ]),
  rule("pantry", [
    "peanut butter",
    "almond butter",
    "nut butter",
    "olive oil",
    "sesame oil",
    "vegetable oil",
    "canola oil",
    "coconut oil",
    "avocado oil",
    "cooking spray",
    "bread crumbs",
    "egg noodles",
    "rice noodles",
    "rice paper",
    "tortilla chips",
    "maple syrup",
    "pine nuts",
    "sesame seeds",
    "dried (?:cranberries|apricots|cherries|figs|mango|blueberries|fruit)",
    "rolled oats"
  ]),
  rule("condiments", [
    "soy sauce",
    "fish sauce",
    "hot sauce",
    "oyster sauce",
    "bbq sauce",
    "barbecue sauce",
    "rice vinegar",
    "wine vinegar",
    "balsamic",
    "apple cider vinegar",
    "chili oil",
    "chili crisp",
    "dijon",
    "salad dressing",
    "rice wine",
    "shaoxing",
    "mirin",
    "cooking wine"
  ]),
  rule("bakery", [
    "flour tortillas",
    "corn tortillas",
    "pita pockets?",
    "pizza dough",
    "pie crusts?"
  ]),
  rule("produce", [
    "bell peppers?",
    "(?:red|green|yellow|orange|sweet|mini|banana|poblano|anaheim|shishito) peppers?",
    "green onions?",
    "spring onions?",
    "sweet potato(?:es)?",
    "green beans",
    "snap peas",
    "snow peas",
    "sugar snap peas",
    "lemon juice",
    "lime juice",
    "lemon zest",
    "lime zest",
    "orange zest",
    "fresh (?:basil|parsley|oregano|thyme|rosemary|dill|sage|tarragon|mint|chives|cilantro|herbs|ginger)",
    "(?:basil|thyme|rosemary|mint|sage) (?:leaves|sprigs?)",
    "corn on the cob",
    "baby spinach",
    "mixed greens",
    "cherry tomato(?:es)?",
    "grape tomato(?:es)?"
  ]),
  rule("meat-seafood", ["ground (?:beef|pork|turkey|chicken|lamb|veal)", ...MEATS]),
  rule("dairy-eggs", DAIRY),
  rule("produce", PRODUCE),
  rule("bakery", BAKERY),
  rule("baking", BAKING),
  rule("condiments", CONDIMENTS),
  rule("canned", CANNED),
  rule("spices", SPICES),
  rule("pantry", PANTRY),
  rule("beverages", BEVERAGES)
];

/** "(packed)" and "[large]" notes; dropped with a linear scan (see text-scan.ts). */
const NOTE_BRACKETS: readonly BracketPair[] = [
  ["(", ")"],
  ["[", "]"]
];
const HEAD_END_PATTERN = /[,;]|\s(?:or|for|to taste|as needed)\b/iu;
const DIACRITIC_PATTERN = /[̀-ͯ]/gu;
const PACKAGED_UNITS = new Set(["can", "tin"]);
const HERB_PATTERN =
  /\b(?:basil|thyme|rosemary|oregano|sage|tarragon|marjoram|dill|mint|parsley|cilantro|chives)\b/i;
const FRESH_HERB_CUE_PATTERN = /\b(?:fresh|chopped|minced|torn|leaves|sprigs?|bunch)\b/i;
const FRESH_UNITS = new Set(["sprig", "bunch", "handful", "stalk"]);
const SPOON_UNITS = new Set(["tsp", "Tbsp", "pinch", "dash"]);

const matchCategory = (text: string): ShoppingCategoryId | null => {
  for (const { category, pattern } of CATEGORY_RULES) {
    if (pattern.test(text)) {
      return category;
    }
  }

  return null;
};

/**
 * The grocery aisle for an ingredient line or shopping item text ("2 cups flour" → "baking",
 * "1 (15 oz) can chickpeas" → "canned", "3 sprigs thyme" → "produce"). Unknown items are
 * "other". Pure and deterministic, so apps can compute it at render time.
 */
export const categorizeIngredient = (text: string): ShoppingCategoryId => {
  const parsed = parseIngredientQuantity(text);
  const name = replaceBracketedGroups(
    (parsed.confident ? parsed.item : text).normalize("NFD").replace(DIACRITIC_PATTERN, ""),
    NOTE_BRACKETS,
    " ",
    { keepSpaces: true }
  );

  if (parsed.unit && PACKAGED_UNITS.has(parsed.unit)) {
    return "canned";
  }

  if (parsed.unit && HERB_PATTERN.test(name)) {
    // "3 sprigs thyme" is fresh; "1 tsp oregano" is the dried jar unless it says otherwise.
    if (FRESH_UNITS.has(parsed.unit)) {
      return "produce";
    }

    if (SPOON_UNITS.has(parsed.unit) && !FRESH_HERB_CUE_PATTERN.test(name)) {
      return "spices";
    }
  }

  const headEnd = HEAD_END_PATTERN.exec(name);
  const head = headEnd ? name.slice(0, headEnd.index) : name;

  return matchCategory(head) ?? matchCategory(name) ?? "other";
};

/** Sort rank of a category in the store walk (produce first, other last). */
export const shoppingCategoryRank = (category: ShoppingCategoryId): number =>
  SHOPPING_CATEGORY_IDS.indexOf(category);

/**
 * Groups items by aisle in store order, keeping each aisle's items in their original order.
 * Empty aisles are omitted.
 */
export const groupByShoppingCategory = <T>(
  items: readonly T[],
  getText: (item: T) => string
): Array<{ category: ShoppingCategoryId; label: string; items: T[] }> => {
  const buckets = new Map<ShoppingCategoryId, T[]>();

  for (const item of items) {
    const category = categorizeIngredient(getText(item));
    const bucket = buckets.get(category);

    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(category, [item]);
    }
  }

  return SHOPPING_CATEGORIES.flatMap(({ id, label }) => {
    const bucket = buckets.get(id);
    return bucket ? [{ category: id, label, items: bucket }] : [];
  });
};
