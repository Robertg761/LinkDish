import type { Recipe } from "@linkdish/recipe-domain";

/**
 * The plain-text formats the recipe editor uses: one ingredient per line with plain-language
 * section headings ("For the sauce:"; "## Section" still reads back), and one step per line.
 */

type EditableIngredient = { section?: string | undefined; text: string };

const LINE_BREAK_PATTERN = /\r?\n/u;
const MARKDOWN_HEADING_PATTERN = /^#{1,3}\s*(.{1,80}?)\s*:?\s*$/u;
const LEGACY_HEADING_PATTERN = /^#?\s*([^:#][^:]{0,80}):$/u;

export const splitEditableLines = (value: string): string[] =>
  value
    .split(LINE_BREAK_PATTERN)
    .map((line) => line.trim())
    .filter(Boolean);

export const splitEditableIngredients = (value: string): EditableIngredient[] => {
  let currentSection: string | undefined;
  const ingredients: EditableIngredient[] = [];

  for (const line of splitEditableLines(value)) {
    const heading =
      line.match(MARKDOWN_HEADING_PATTERN)?.[1]?.trim() ||
      line.match(LEGACY_HEADING_PATTERN)?.[1]?.trim();

    if (heading) {
      currentSection = heading;
      continue;
    }

    ingredients.push({
      ...(currentSection ? { section: currentSection } : {}),
      text: line
    });
  }

  return ingredients;
};

export const formatEditableIngredients = (ingredients: Recipe["ingredients"]): string => {
  const lines: string[] = [];
  let currentSection: string | null | undefined;

  for (const ingredient of ingredients) {
    const section = ingredient.section?.trim();

    if (section && section !== currentSection) {
      if (lines.length > 0) {
        lines.push("");
      }

      // "For the sauce:" reads like a recipe; a name that itself has a colon keeps "## ".
      lines.push(section.includes(":") ? `## ${section}` : `${section}:`);
      currentSection = section;
    } else if (!section && currentSection) {
      lines.push("");
      currentSection = null;
    }

    lines.push(ingredient.text);
  }

  return lines.join("\n");
};

export const formatEditableSteps = (steps: Recipe["steps"]): string =>
  [...steps]
    .sort((left, right) => left.index - right.index)
    .map((step) => step.text)
    .join("\n");

/** Minutes from a field ("", "45", "1:30" is not accepted — whole minutes only). */
export const parseMinutesField = (value: string): number | null | "invalid" => {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (!/^\d{1,5}$/u.test(trimmed)) {
    return "invalid";
  }

  const minutes = Number(trimmed);
  return minutes <= 10_080 ? minutes : "invalid";
};

export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
