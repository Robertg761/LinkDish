import type { Recipe } from "../../../../../../packages/recipe-domain/src/index.js";

/*
 * Many food creators post a video with no recipe in the caption ("Recipe in comments") and keep
 * the written recipe on their own site, which their page is often named after ("fedbysab.com").
 * Facebook shows comments only to signed-in people, so LinkDish looks the dish up on that site.
 *
 * A creator's site holds many similar recipes (a buffalo and a taco version of the same
 * quesadilla ring), and their titles alone can match a caption equally well, so a candidate is
 * judged on its whole recipe (title, description, ingredients and steps). The best candidate
 * must clearly win: a tie, or a weak match, is no match at all, because importing the wrong
 * recipe is worse than importing none.
 */

/* Hosts that are platforms, link hubs or shops, never a creator's own recipe site. */
const platformHostPattern =
  /(?:^|\.)(?:facebook\.com|fb\.com|fb\.me|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|threads\.net|pinterest\.[a-z.]+|linktr\.ee|beacons\.ai|stan\.store|patreon\.com|amazon\.[a-z.]+|amzn\.to|etsy\.com|shopify\.com|google\.com|substack\.com)$/iu;

const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u;

/**
 * The creator's own website when their page name is a bare domain ("fedbysab.com",
 * "www.cook.example"), else null. Names that only contain a dot ("Mrs. Smith") are not domains.
 */
export const readCreatorSiteDomain = (authorName: string | null): string | null => {
  if (!authorName) {
    return null;
  }

  const candidate = authorName
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "")
    .replace(/^www\./u, "");

  if (candidate.length > 100 || !domainPattern.test(candidate)) {
    return null;
  }

  return platformHostPattern.test(candidate) ? null : candidate;
};

/* Words that say nothing about which dish it is. */
const stopWords = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "with",
  "in",
  "on",
  "for",
  "to",
  "my",
  "your",
  "our",
  "this",
  "these",
  "that",
  "is",
  "it",
  "at",
  "or",
  "by",
  "from",
  "recipe",
  "recipes",
  "easy",
  "best",
  "homemade",
  "quick",
  "simple",
  "ultimate",
  "perfect",
  "delicious",
  "new",
  "how",
  "make",
  "made",
  "comment",
  "comments",
  "below",
  "link",
  "bio",
  "full",
  /* Reactions: "so good", "must try", "you need this". */
  "so",
  "good",
  "yum",
  "yummy",
  "omg",
  "wow",
  "love",
  "amazing",
  "tasty",
  "must",
  "try",
  "ever",
  "you",
  "need",
  "today",
  "tonight",
  "idea",
  "ideas",
  /* Labels a caption adds that a recipe page rarely repeats: "viral", "copycat", "3 ingredient". */
  "viral",
  "copycat",
  "famous",
  "trending",
  "version",
  "style",
  "inspired",
  "hack",
  "hacks",
  "ingredient",
  "ingredients",
  "minute",
  "minutes",
  "min",
  "weeknight",
  "facebook",
  "tiktok",
  "reel",
  "video"
]);

/* "Recipe in comments", "Full recipe below", "Link in bio", "Comment RECIPE and I'll send it". */
const fillerPhrasePattern =
  /\b(?:(?:full\s+|written\s+|printable\s+)?recipes?\s+(?:is\s+)?(?:(?:down\s+)?(?:in|below\s+in)\s+(?:the\s+)?(?:first\s+)?(?:comments?|bio)|below|in\s+bio|on\s+(?:my|the)\s+(?:website|blog|site))|link\s+in\s+(?:my\s+)?bio|comment\s+["'“”]?\w+["'“”]?(?:\s+(?:and|for)\b[^.!\n]*)?|save\s+(?:this|for\s+later)|follow\s+for\s+more)\b/giu;

const emojiPattern =
  /(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}|\u{20E3})+/gu;

const stem = (word: string): string =>
  word.length > 4 && word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word;

/** The words of a text that can name a dish, lowercased, without accents and plurals. */
export const dishTokens = (text: string): Set<string> =>
  new Set(
    text
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 1 && !stopWords.has(word) && !/^\d+$/u.test(word))
      .map(stem)
  );

const minDishTokens = 2;
const maxDishQueryWords = 8;

/**
 * The dish a caption names, as a search query: "🚨 Recipe in Comments ⭐️ Pull Apart Buffalo
 * Chicken Quesadilla Ring 🧀" is "Pull Apart Buffalo Chicken Quesadilla Ring". The first part of
 * the opening lines that still names something once emoji, hashtags, links and filler like
 * "recipe in comments" are gone. Null when no part names at least two dish words.
 */
export const readDishQuery = (caption: string): string | null => {
  const lines = caption
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  for (const line of lines) {
    const segments = line
      .replace(/https?:\/\/\S+/gu, " ")
      .replace(/[#@][\p{L}\p{N}_.]+/gu, " ")
      .replace(emojiPattern, "|")
      .split(/[|•·:!?()[\]]+|\s[-–—]\s/u);

    for (const segment of segments) {
      const cleaned = segment
        .replace(fillerPhrasePattern, " ")
        .replace(/[^\p{L}\p{N}'&\s-]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();

      if (dishTokens(cleaned).size >= minDishTokens) {
        return cleaned.split(" ").slice(0, maxDishQueryWords).join(" ");
      }
    }
  }

  return null;
};

const overlapCount = (left: Set<string>, right: Set<string>): number => {
  let count = 0;

  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }

  return count;
};

/**
 * Whether a search result's title plausibly names the dish: at least two of its words are in
 * the caption and they make up at least half of its title. Returns the number of shared words,
 * or 0 when it does not qualify.
 */
export const scoreCandidateTitle = (query: string, title: string): number => {
  const queryTokens = dishTokens(query);
  const titleTokens = dishTokens(title);
  const shared = overlapCount(queryTokens, titleTokens);

  return shared >= minDishTokens && shared * 2 >= titleTokens.size ? shared : 0;
};

/** Share of the caption's dish words found anywhere in the recipe. */
export const scoreRecipeContent = (query: string, recipe: Recipe): number => {
  const queryTokens = dishTokens(query);

  if (queryTokens.size === 0) {
    return 0;
  }

  const recipeTokens = dishTokens(
    [
      recipe.title,
      recipe.description ?? "",
      ...recipe.ingredients.map((ingredient) => ingredient.text),
      ...recipe.steps.map((step) => step.text)
    ].join("\n")
  );

  return overlapCount(queryTokens, recipeTokens) / queryTokens.size;
};

/*
 * Every one of the caption's dish words must be in the chosen recipe. A near miss is usually the
 * creator's other version of the dish: their taco quesadilla ring covers every word of "Pull
 * Apart Buffalo Chicken Quesadilla Ring" but "buffalo", and that one word is the whole difference.
 */
export const minRecipeContentScore = 1;

/**
 * The index of the recipe that matches the caption, or null when none is a confident match:
 * its own title must qualify, its whole text must hold every dish word of the caption, and no
 * other candidate may do as well (two that do are ambiguous).
 */
export const pickMatchingRecipe = (query: string, recipes: (Recipe | null)[]): number | null => {
  const scored = recipes
    .map((recipe, index) =>
      recipe && scoreCandidateTitle(query, recipe.title) > 0
        ? { index, score: scoreRecipeContent(query, recipe) }
        : null
    )
    .filter((entry): entry is { index: number; score: number } => entry !== null)
    .sort((left, right) => right.score - left.score);
  const [best, runnerUp] = scored;

  if (!best || best.score < minRecipeContentScore) {
    return null;
  }

  return runnerUp && runnerUp.score >= best.score ? null : best.index;
};
