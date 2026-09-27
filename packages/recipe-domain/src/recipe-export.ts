/**
 * Sharing a recipe outside LinkDish: plain text for messages and the clipboard, Markdown for
 * notes apps, and schema.org JSON-LD for share pages and interoperability. Scale and unit
 * choices apply the same way they do in cook mode.
 */
import { convertTemperaturesInText, getDisplayIngredientText } from "./conversion.js";
import { getRecipeTimes } from "./durations.js";
import { formatServings } from "./servings.js";

import type { IngredientUnitsPreference } from "./conversion.js";
import type { Recipe } from "./recipe-schema.js";

export type RecipeExportOptions = {
  scale?: number | undefined;
  units?: IngredientUnitsPreference | undefined;
  /** Personal notes appended after the steps. */
  notes?: string | null | undefined;
  /** Include the "Source:" line (default true). */
  includeSource?: boolean | undefined;
};

type ExportableRecipe = Pick<Recipe, "title" | "ingredients" | "steps" | "sourceUrl" | "servings"> &
  Partial<
    Pick<
      Recipe,
      | "prepTimeMinutes"
      | "cookTimeMinutes"
      | "totalTimeMinutes"
      | "description"
      | "image"
      | "author"
      | "siteName"
      | "cuisine"
      | "category"
      | "keywords"
      | "videoUrl"
      | "nutrition"
    >
  >;

type IngredientGroup = { section: string | null; lines: string[] };

const groupIngredients = (
  recipe: ExportableRecipe,
  options: RecipeExportOptions
): IngredientGroup[] => {
  const groups: IngredientGroup[] = [];

  for (const ingredient of recipe.ingredients) {
    const section = ingredient.section?.trim() || null;
    const text = getDisplayIngredientText(ingredient.text, {
      scale: options.scale ?? 1,
      units: options.units ?? "original",
      keepOriginalText: true
    });
    const current = groups[groups.length - 1];

    if (current && current.section === section) {
      current.lines.push(text);
    } else {
      groups.push({ section, lines: [text] });
    }
  }

  return groups;
};

const stepTexts = (recipe: ExportableRecipe, options: RecipeExportOptions): string[] =>
  [...recipe.steps]
    .sort((left, right) => left.index - right.index)
    .map((step) =>
      options.units && options.units !== "original"
        ? convertTemperaturesInText(step.text, options.units)
        : step.text
    );

const summaryLine = (recipe: ExportableRecipe, options: RecipeExportOptions): string => {
  const servings = recipe.servings
    ? formatServings(recipe.servings, { scale: options.scale ?? 1 })
    : "";
  const times = getRecipeTimes(recipe).display;
  return [servings, times].filter((part) => part.length > 0).join(" · ");
};

/**
 * Plain-text recipe for messages and the clipboard:
 *
 *     Title
 *     Serves 4 · Prep 10 min · Cook 20 min · Total 30 min
 *
 *     INGREDIENTS
 *     For the sauce
 *     • 3 Tbsp soy sauce
 *
 *     STEPS
 *     1. Whisk…
 *
 *     Source: https://…
 */
export const recipeToPlainText = (
  recipe: ExportableRecipe,
  options: RecipeExportOptions = {}
): string => {
  const blocks: string[] = [];
  const summary = summaryLine(recipe, options);
  blocks.push(summary ? `${recipe.title}\n${summary}` : recipe.title);

  if (recipe.description) {
    blocks.push(recipe.description);
  }

  const ingredientLines = ["INGREDIENTS"];

  for (const group of groupIngredients(recipe, options)) {
    if (group.section) {
      ingredientLines.push(group.section);
    }

    ingredientLines.push(...group.lines.map((line) => `• ${line}`));
  }

  blocks.push(ingredientLines.join("\n"));
  blocks.push(
    ["STEPS", ...stepTexts(recipe, options).map((text, index) => `${index + 1}. ${text}`)].join(
      "\n"
    )
  );

  if (options.notes?.trim()) {
    blocks.push(`NOTES\n${options.notes.trim()}`);
  }

  if (options.includeSource ?? true) {
    blocks.push(`Source: ${recipe.sourceUrl}`);
  }

  return blocks.join("\n\n");
};

const MARKDOWN_SPECIAL_PATTERN = /([\\`*_[\]<>|])/gu;
const MARKDOWN_LINE_START_PATTERN = /^(\s*)([#>+-]|\d+\.)(\s)/gmu;
/** Parentheses would end a Markdown link target early. */
const URL_PARENTHESIS_PATTERN = /[()]/gu;

/** Escapes Markdown syntax so recipe text renders literally. */
const escapeMarkdown = (text: string): string =>
  text.replace(MARKDOWN_SPECIAL_PATTERN, "\\$1").replace(MARKDOWN_LINE_START_PATTERN, "$1\\$2$3");

/** Markdown recipe for notes apps: title heading, summary, grouped ingredients, numbered steps. */
export const recipeToMarkdown = (
  recipe: ExportableRecipe,
  options: RecipeExportOptions = {}
): string => {
  const blocks: string[] = [`# ${escapeMarkdown(recipe.title)}`];
  const summary = summaryLine(recipe, options);

  if (summary) {
    blocks.push(`_${escapeMarkdown(summary)}_`);
  }

  if (recipe.description) {
    blocks.push(escapeMarkdown(recipe.description));
  }

  const ingredientBlocks = ["## Ingredients"];

  for (const group of groupIngredients(recipe, options)) {
    const list = group.lines.map((line) => `- ${escapeMarkdown(line)}`).join("\n");
    ingredientBlocks.push(group.section ? `### ${escapeMarkdown(group.section)}\n\n${list}` : list);
  }

  blocks.push(ingredientBlocks.join("\n\n"));
  blocks.push(
    [
      "## Steps",
      stepTexts(recipe, options)
        .map((text, index) => `${index + 1}. ${escapeMarkdown(text)}`)
        .join("\n")
    ].join("\n\n")
  );

  if (options.notes?.trim()) {
    blocks.push(`## Notes\n\n${escapeMarkdown(options.notes.trim())}`);
  }

  if (options.includeSource ?? true) {
    blocks.push(
      `[Source](${recipe.sourceUrl.replace(URL_PARENTHESIS_PATTERN, (paren) => (paren === "(" ? "%28" : "%29"))})`
    );
  }

  return `${blocks.join("\n\n")}\n`;
};

/** Minutes as an ISO 8601 duration: 90 → "PT1H30M", 45 → "PT45M", 0 → "PT0M". */
export const toIsoDuration = (minutes: number): string => {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;

  if (hours === 0) {
    return `PT${rest}M`;
  }

  return rest === 0 ? `PT${hours}H` : `PT${hours}H${rest}M`;
};

/**
 * A schema.org Recipe object (JSON-LD) for a recipe, suitable for a share page's
 * `<script type="application/ld+json">` or for other apps. Fields the recipe doesn't have are
 * omitted; times are ISO 8601 durations.
 */
export const recipeToJsonLd = (
  recipe: ExportableRecipe,
  options: { url?: string | undefined } = {}
): Record<string, unknown> => {
  const times = getRecipeTimes(recipe);
  const nutrition = recipe.nutrition
    ? Object.fromEntries(
        (
          [
            ["calories", recipe.nutrition.calories],
            ["proteinContent", recipe.nutrition.protein],
            ["carbohydrateContent", recipe.nutrition.carbohydrates],
            ["fatContent", recipe.nutrition.fat],
            ["fiberContent", recipe.nutrition.fiber],
            ["sugarContent", recipe.nutrition.sugar],
            ["sodiumContent", recipe.nutrition.sodium]
          ] as const
        ).filter(([, value]) => value != null)
      )
    : null;

  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: recipe.title,
    ...(recipe.description ? { description: recipe.description } : {}),
    ...(recipe.image ? { image: [recipe.image.url] } : {}),
    ...(recipe.author ? { author: { "@type": "Person", name: recipe.author } } : {}),
    ...(recipe.siteName ? { publisher: { "@type": "Organization", name: recipe.siteName } } : {}),
    url: options.url ?? recipe.sourceUrl,
    ...(recipe.servings ? { recipeYield: recipe.servings } : {}),
    ...(times.prep != null ? { prepTime: toIsoDuration(times.prep) } : {}),
    ...(times.cook != null ? { cookTime: toIsoDuration(times.cook) } : {}),
    ...(times.total != null ? { totalTime: toIsoDuration(times.total) } : {}),
    ...(recipe.cuisine ? { recipeCuisine: recipe.cuisine } : {}),
    ...(recipe.category ? { recipeCategory: recipe.category } : {}),
    ...(recipe.keywords && recipe.keywords.length > 0
      ? { keywords: recipe.keywords.join(", ") }
      : {}),
    recipeIngredient: recipe.ingredients.map((ingredient) => ingredient.text),
    recipeInstructions: [...recipe.steps]
      .sort((left, right) => left.index - right.index)
      .map((step) => ({ "@type": "HowToStep", text: step.text })),
    ...(recipe.videoUrl ? { video: { "@type": "VideoObject", contentUrl: recipe.videoUrl } } : {}),
    ...(nutrition && Object.keys(nutrition).length > 0
      ? { nutrition: { "@type": "NutritionInformation", ...nutrition } }
      : {})
  };
};
