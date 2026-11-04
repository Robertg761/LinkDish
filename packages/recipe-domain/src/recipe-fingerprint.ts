const withSortedKeys = (_key: string, value: unknown): unknown =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      )
    : value;

/**
 * Identifies a recipe's content (the recipe and its notes), whatever order its keys are stored in.
 * Equal fingerprints mean two records show the same thing, so one can stand in for the other.
 */
export const recipeContentFingerprint = (entry: {
  notes?: string | null | undefined;
  recipe: unknown;
}): string => JSON.stringify([entry.recipe, entry.notes?.trim() ?? ""], withSortedKeys);
