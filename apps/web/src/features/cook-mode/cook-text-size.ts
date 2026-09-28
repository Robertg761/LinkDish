import type { CookTextSize } from "../../preferences/preferences-store";

/**
 * The one set of names for the cook-mode step text size, shown by the cook-mode settings sheet
 * and meant for Settings too, so a preference never has two sets of labels.
 */
export const COOK_TEXT_SIZE_OPTIONS: ReadonlyArray<{ value: CookTextSize; label: string }> = [
  { label: "Regular", value: "md" },
  { label: "Large", value: "lg" },
  { label: "Largest", value: "xl" }
];
