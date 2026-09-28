import { parseDuration } from "../../../../../../../packages/recipe-domain/src/index.js";
import { getParsedHtmlDocument, type ParsedHtmlDocument } from "../../html/parsed-html-document.js";
import { getDomainAdapter } from "../../source-detection/domain-adapters.js";
import { captureRecipeImage } from "../capture-recipe-image.js";
import { htmlFragmentToText } from "../html-text.js";
import {
  buildFieldProvenance,
  extractMinutesFromText,
  extractItemsFromSelectors,
  extractNutritionFromText,
  extractSectionContent,
  extractSectionListItems,
  parseServingsText,
  parseTextRecipeSignals,
  toIngredientLines,
  toStepLines,
  uniqueNonEmptyText
} from "../shared.js";

import {
  findJsonLdRecipe,
  isJsonRecord,
  readJsonLdAuthor,
  readJsonLdDurationMinutes,
  readJsonLdIngredientLines,
  readJsonLdInstructionLines,
  readJsonLdKeywords,
  readJsonLdText,
  readJsonLdTextList,
  readJsonLdVideoUrl,
  readJsonLdYield,
  type JsonRecord
} from "./json-ld.js";

import type { Recipe } from "../../../../../../../packages/recipe-domain/src/index.js";
import type { ExtractionCandidate, HtmlSourceDocument } from "../../types.js";
import type { CheerioAPI } from "cheerio";

interface LooseNutritionShape {
  calories: string | null | undefined;
  proteinContent: string | null | undefined;
  carbohydrateContent: string | null | undefined;
  fatContent: string | null | undefined;
  fiberContent: string | null | undefined;
  sugarContent: string | null | undefined;
  sodiumContent: string | null | undefined;
}

/** The optional metadata fields a candidate can carry (all additive on the recipe contract). */
type RecipeMetadata = Pick<
  Recipe,
  | "description"
  | "totalTimeMinutes"
  | "author"
  | "siteName"
  | "cuisine"
  | "category"
  | "keywords"
  | "videoUrl"
>;

type RecipeMetadataInput = {
  [Key in keyof RecipeMetadata]-?: Exclude<RecipeMetadata[Key], undefined> | null;
};

/* Only fields with a value are set, so recipes without metadata keep their previous shape. */
const compactMetadata = (metadata: RecipeMetadataInput): RecipeMetadata => {
  const compacted: RecipeMetadata = {};

  for (const [key, value] of Object.entries(metadata) as Array<
    [keyof RecipeMetadataInput, RecipeMetadataInput[keyof RecipeMetadataInput]]
  >) {
    if (value != null && (!Array.isArray(value) || value.length > 0)) {
      Object.assign(compacted, { [key]: value });
    }
  }

  return compacted;
};

const readMetaText = (value: string | undefined): string | null => {
  const text = value ? htmlFragmentToText(value) : "";
  return text.length > 0 ? text : null;
};

const readPageDescription = (parsed: ParsedHtmlDocument, document: HtmlSourceDocument) =>
  readMetaText(document.description ?? undefined) ??
  readMetaText(parsed.metaContent("property", "og:description")) ??
  readMetaText(parsed.metaContent("name", "description"));

const readPageSiteName = (parsed: ParsedHtmlDocument) =>
  readMetaText(parsed.metaContent("property", "og:site_name")) ??
  readMetaText(parsed.metaContent("name", "application-name"));

const readPageAuthor = (parsed: ParsedHtmlDocument): string | null => {
  const author = readMetaText(parsed.metaContent("name", "author"));
  return author && !/^https?:\/\//iu.test(author) ? author : null;
};

const toNullableNutritionValue = (value: unknown): string | null => {
  const text = readJsonLdText(value);
  return text && text.length > 0 ? text : null;
};

const normalizeNutrition = (nutrition: LooseNutritionShape | JsonRecord | null | undefined) => {
  if (!nutrition) {
    return null;
  }

  const normalizedNutrition = {
    calories: toNullableNutritionValue(nutrition.calories),
    protein: toNullableNutritionValue(nutrition.proteinContent),
    carbohydrates: toNullableNutritionValue(nutrition.carbohydrateContent),
    fat: toNullableNutritionValue(nutrition.fatContent),
    fiber: toNullableNutritionValue(nutrition.fiberContent),
    sugar: toNullableNutritionValue(nutrition.sugarContent),
    sodium: toNullableNutritionValue(nutrition.sodiumContent)
  };

  const hasAnyNutrition = Object.values(normalizedNutrition).some((value) => value !== null);

  return hasAnyNutrition ? normalizedNutrition : null;
};

type CheerioSelection = ReturnType<CheerioAPI>;
type CapturedImage = ReturnType<typeof captureRecipeImage>;

interface IngredientGroup {
  section: string | null;
  count: number;
}

const collapseText = (value: string): string => value.replace(/\s+/g, " ").trim();

/*
 * JSON-LD recipeIngredient is a flat list, but recipe plugins group ingredients in the page
 * ("For the cake", "For the frosting"). WP Recipe Maker and Tasty Recipes mark those groups up
 * predictably, so their names become ingredient sections when the page's group sizes add up to
 * exactly the structured list (otherwise the list stays flat rather than risk mislabelling).
 */
const readIngredientGroups = ($: CheerioAPI): IngredientGroup[] => {
  const groups: IngredientGroup[] = [];

  $(".wprm-recipe-ingredient-group").each((_, element) => {
    const group = $(element);
    const count = group.find(".wprm-recipe-ingredient").length;

    if (count > 0) {
      const name = collapseText(group.find(".wprm-recipe-group-name").first().text());
      groups.push({ section: name || null, count });
    }
  });

  if (groups.length > 0) {
    return groups;
  }

  const tastyBody = $(".tasty-recipes-ingredients-body, .tasty-recipes-ingredients").first();
  let section: string | null = null;

  tastyBody.find("h3, h4, ul, ol").each((_, element) => {
    const node = $(element);

    if (node.is("h3, h4")) {
      section = collapseText(node.text()) || null;
      return;
    }

    const count = node.children("li").length;

    if (count > 0) {
      groups.push({ section, count });
    }
  });

  return groups;
};

const stripTrailingColon = (value: string): string => value.replace(/:\s*$/u, "").trim();

const withIngredientSections = (
  ingredients: { text: string }[],
  groups: IngredientGroup[]
): { text: string; section?: string }[] => {
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  if (!groups.some((group) => group.section) || total !== ingredients.length) {
    return ingredients;
  }

  const sectioned: { text: string; section?: string }[] = [];
  let index = 0;

  for (const group of groups) {
    const section = group.section ? stripTrailingColon(group.section) : "";

    for (let offset = 0; offset < group.count; offset += 1) {
      const ingredient = ingredients[index];
      index += 1;

      if (ingredient) {
        sectioned.push(section ? { ...ingredient, section } : ingredient);
      }
    }
  }

  return sectioned;
};

/* Microdata times live in content= (meta), datetime= (time) or the element text. */
const readMicrodataMinutes = (root: CheerioSelection, property: string): number | null => {
  const element = root.find(`[itemprop="${property}"]`).first();

  if (element.length === 0) {
    return null;
  }

  return parseDuration(
    element.attr("content") ?? element.attr("datetime") ?? collapseText(element.text())
  );
};

const readMicrodataText = (root: CheerioSelection, property: string): string | null => {
  const element = root.find(`[itemprop="${property}"]`).first();

  if (element.length === 0) {
    return null;
  }

  const text = collapseText(element.attr("content") ?? element.text());
  return text.length > 0 ? text : null;
};

const readMicrodataAuthor = (root: CheerioSelection): string | null => {
  const author = root.find('[itemprop="author"]').first();

  if (author.length === 0) {
    return null;
  }

  const name = collapseText(
    author.find('[itemprop="name"]').first().attr("content") ??
      author.find('[itemprop="name"]').first().text() ??
      ""
  );
  const text = name || collapseText(author.attr("content") ?? author.text());

  return text.length > 0 && !/^https?:\/\//iu.test(text) ? text : null;
};

const extractFromJsonLd = (
  document: HtmlSourceDocument,
  parsed: ParsedHtmlDocument,
  pageTitle: string,
  image: CapturedImage
): ExtractionCandidate | null => {
  const match = findJsonLdRecipe(parsed.jsonLdBlocks);

  if (!match) {
    return null;
  }

  const { recipe: node } = match;
  const name = readJsonLdText(node.name);
  const recipeYield = readJsonLdYield(node.recipeYield);
  const prepTimeMinutes = readJsonLdDurationMinutes(node.prepTime);
  const cookTimeMinutes = readJsonLdDurationMinutes(node.cookTime);
  const totalTimeMinutes = readJsonLdDurationMinutes(node.totalTime);
  const nutrition = normalizeNutrition(isJsonRecord(node.nutrition) ? node.nutrition : null);
  const ingredients = withIngredientSections(
    toIngredientLines(readJsonLdIngredientLines(node.recipeIngredient ?? node.ingredients), {
      structured: true
    }),
    readIngredientGroups(parsed.$)
  );
  const publisher = isJsonRecord(node.publisher) ? readJsonLdText(node.publisher.name) : null;

  return {
    recipe: {
      title: name ?? pageTitle,
      sourceUrl: document.finalUrl,
      sourceType: "recipe-webpage",
      image,
      ingredients,
      steps: toStepLines(readJsonLdInstructionLines(node.recipeInstructions), {
        structured: true
      }),
      servings: parseServingsText(recipeYield),
      prepTimeMinutes,
      cookTimeMinutes,
      nutrition,
      ...compactMetadata({
        description: readJsonLdText(node.description) ?? readPageDescription(parsed, document),
        totalTimeMinutes,
        author: readJsonLdAuthor(node.author) ?? readPageAuthor(parsed),
        siteName: readPageSiteName(parsed) ?? match.siteName ?? publisher,
        cuisine: readJsonLdTextList(node.recipeCuisine),
        category: readJsonLdTextList(node.recipeCategory),
        keywords: readJsonLdKeywords(node.keywords),
        videoUrl: readJsonLdVideoUrl(node.video)
      })
    },
    strategy: "recipe-schema",
    evidence: ["Detected Recipe JSON-LD on the page."],
    warnings: [],
    provenance: ["jsonld"],
    fieldProvenance: buildFieldProvenance({
      title: name ? "jsonld" : "visible-text",
      ingredients: "jsonld",
      steps: "jsonld",
      servings: recipeYield ? "jsonld" : null,
      prepTimeMinutes: prepTimeMinutes == null ? null : "jsonld",
      cookTimeMinutes: cookTimeMinutes == null ? null : "jsonld",
      nutrition: nutrition ? "jsonld" : null
    }),
    signals: {
      requiredFieldsInferred: false,
      titleConfidence: name ? "strong" : "weak",
      timesFromStructuredMetadata:
        prepTimeMinutes != null || cookTimeMinutes != null || totalTimeMinutes != null,
      recipeLike: true,
      detectionConfidence: "high",
      sectionCohesion: "strong",
      transcriptQuality: "weak",
      usedBrowserFallback: false,
      blockedSourceSignals: document.blockedSignals.length
    }
  };
};

const extractFromMicrodata = (
  document: HtmlSourceDocument,
  parsed: ParsedHtmlDocument,
  pageTitle: string,
  image: CapturedImage
): ExtractionCandidate | null => {
  const { $ } = parsed;
  const microdataRoot = $('[itemtype*="Recipe"]').first();

  if (microdataRoot.length === 0) {
    return null;
  }

  const microdataIngredients = microdataRoot
    .find('[itemprop="recipeIngredient"], [itemprop="ingredients"]')
    .toArray()
    .map((node) => $(node).text());
  const microdataSteps = uniqueNonEmptyText(
    microdataRoot
      .find('[itemprop="recipeInstructions"]')
      .toArray()
      .flatMap((node) => {
        const text = $(node).text();
        return text.split(/\n+/);
      })
  );
  const microdataNutrition = normalizeNutrition({
    calories: microdataRoot.find('[itemprop="calories"]').first().text().trim() || undefined,
    proteinContent:
      microdataRoot.find('[itemprop="proteinContent"]').first().text().trim() || undefined,
    carbohydrateContent:
      microdataRoot.find('[itemprop="carbohydrateContent"]').first().text().trim() || undefined,
    fatContent: microdataRoot.find('[itemprop="fatContent"]').first().text().trim() || undefined,
    fiberContent:
      microdataRoot.find('[itemprop="fiberContent"]').first().text().trim() || undefined,
    sugarContent:
      microdataRoot.find('[itemprop="sugarContent"]').first().text().trim() || undefined,
    sodiumContent:
      microdataRoot.find('[itemprop="sodiumContent"]').first().text().trim() || undefined
  });
  const yieldText = microdataRoot.find('[itemprop="recipeYield"]').first().text().trim() || null;
  /*
   * totalTime is its own field: it used to be copied into both prep and cook when either was
   * missing, which doubled the recipe's total in clients that add prep + cook.
   */
  const prepTimeMinutes = readMicrodataMinutes(microdataRoot, "prepTime");
  const cookTimeMinutes = readMicrodataMinutes(microdataRoot, "cookTime");
  const totalTimeMinutes = readMicrodataMinutes(microdataRoot, "totalTime");
  const keywords = readMicrodataText(microdataRoot, "keywords");

  return {
    recipe: {
      title: microdataRoot.find('[itemprop="name"]').first().text().trim() || pageTitle,
      sourceUrl: document.finalUrl,
      sourceType: "recipe-webpage",
      image,
      ingredients: toIngredientLines(microdataIngredients, { structured: true }),
      steps: toStepLines(microdataSteps, { structured: true }),
      servings: parseServingsText(yieldText),
      prepTimeMinutes,
      cookTimeMinutes,
      nutrition: microdataNutrition ?? extractNutritionFromText(microdataRoot.text()),
      ...compactMetadata({
        description:
          readMicrodataText(microdataRoot, "description") ?? readPageDescription(parsed, document),
        totalTimeMinutes,
        author: readMicrodataAuthor(microdataRoot) ?? readPageAuthor(parsed),
        siteName: readPageSiteName(parsed),
        cuisine: readMicrodataText(microdataRoot, "recipeCuisine"),
        category: readMicrodataText(microdataRoot, "recipeCategory"),
        keywords: keywords ? readJsonLdKeywords(keywords) : null,
        videoUrl: null
      })
    },
    strategy: "recipe-schema",
    evidence: ["Detected recipe microdata on the page."],
    warnings: ["Recipe JSON-LD was unavailable, so microdata was used instead."],
    provenance: ["microdata", ...(microdataNutrition ? [] : ["visible-text" as const])],
    fieldProvenance: buildFieldProvenance({
      title: "microdata",
      ingredients: "microdata",
      steps: "microdata",
      servings: yieldText ? "microdata" : null,
      prepTimeMinutes: prepTimeMinutes == null ? null : "microdata",
      cookTimeMinutes: cookTimeMinutes == null ? null : "microdata",
      nutrition: microdataNutrition
        ? "microdata"
        : microdataRoot.text().trim()
          ? "visible-text"
          : null
    }),
    signals: {
      requiredFieldsInferred: false,
      titleConfidence: "strong",
      timesFromStructuredMetadata:
        prepTimeMinutes != null || cookTimeMinutes != null || totalTimeMinutes != null,
      recipeLike: true,
      detectionConfidence: "high",
      sectionCohesion: "strong",
      transcriptQuality: "weak",
      usedBrowserFallback: false,
      blockedSourceSignals: document.blockedSignals.length
    }
  };
};

export const extractRecipeWebpage = (document: HtmlSourceDocument): ExtractionCandidate | null => {
  const parsed = getParsedHtmlDocument(document);
  const { $ } = parsed;
  const pageTitle = parsed.firstHeadingText.trim() || document.title || parsed.titleText.trim();
  const adapter = getDomainAdapter(new URL(document.finalUrl).hostname.toLowerCase());
  const image = captureRecipeImage(parsed, document.finalUrl);
  const structuredCandidate =
    extractFromJsonLd(document, parsed, pageTitle, image) ??
    extractFromMicrodata(document, parsed, pageTitle, image);

  if (structuredCandidate) {
    return structuredCandidate;
  }

  const adapterIngredientItems = adapter
    ? extractItemsFromSelectors($, adapter.selectors.ingredients)
    : [];
  const adapterStepItems = adapter ? extractItemsFromSelectors($, adapter.selectors.steps) : [];
  const ingredientItems =
    adapterIngredientItems.length > 0
      ? adapterIngredientItems
      : [
          ...extractSectionListItems($, /ingredients?/i),
          ...extractSectionContent($, /ingredients?/i)
        ];
  const stepItems =
    adapterStepItems.length > 0
      ? adapterStepItems
      : [
          ...extractSectionListItems($, /(instructions?|directions?|method)/i),
          ...extractSectionContent($, /(instructions?|directions?|method|steps?)/i)
        ];
  const textSignals = parseTextRecipeSignals([...ingredientItems, ...stepItems]);

  if (!textSignals.signals.recipeLike) {
    return null;
  }

  const combinedText = $.text();
  const yieldText = combinedText.match(/yield[:\s]+([^\n.]+)/i)?.[1];
  const prepTimeMinutes = extractMinutesFromText(combinedText, "prep");
  const cookTimeMinutes = extractMinutesFromText(combinedText, "cook");
  const nutrition = extractNutritionFromText(combinedText);

  return {
    recipe: {
      title: pageTitle,
      sourceUrl: document.finalUrl,
      sourceType: "recipe-webpage",
      image,
      ingredients: toIngredientLines(ingredientItems),
      steps: toStepLines(stepItems),
      servings: parseServingsText(yieldText ?? null),
      prepTimeMinutes,
      cookTimeMinutes,
      nutrition,
      ...compactMetadata({
        description: readPageDescription(parsed, document),
        totalTimeMinutes: null,
        author: readPageAuthor(parsed),
        siteName: readPageSiteName(parsed),
        cuisine: null,
        category: null,
        keywords: null,
        videoUrl: null
      })
    },
    strategy: "recipe-adapter-dom",
    evidence: [
      adapter
        ? `Used adapter-aware selectors for ${adapter.key} after structured recipe metadata was unavailable.`
        : "Used section-based heuristics after structured recipe metadata was unavailable."
    ],
    warnings: ["Recipe details were inferred from visible page sections."],
    provenance: ["visible-text"],
    fieldProvenance: buildFieldProvenance({
      title: "visible-text",
      ingredients: "visible-text",
      steps: "visible-text",
      servings: yieldText ? "visible-text" : null,
      prepTimeMinutes: prepTimeMinutes == null ? null : "visible-text",
      cookTimeMinutes: cookTimeMinutes == null ? null : "visible-text",
      nutrition: nutrition ? "visible-text" : null
    }),
    signals: textSignals.signals
  };
};
