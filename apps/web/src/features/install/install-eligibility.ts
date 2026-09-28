import { createStorageFlag, useStorageFlag } from "../../platform/storage-flag";

/**
 * When the install tip may show: after the first recipe lands in the cookbook, until the cook
 * dismisses it. Both are subscribable, so a tip already on screen (the importer's sidebar, next to
 * the import queue) appears the moment a save finishes, here or in another tab.
 */

/** Unversioned keys, kept as shipped so existing cooks keep their state. */
export const HAS_SAVED_RECIPE_STORAGE_KEY = "linkdish:web:has-extracted-recipe";
export const INSTALL_PROMPT_DISMISSED_STORAGE_KEY = "linkdish:web:install-prompt-dismissed";

const hasSavedRecipe = createStorageFlag(HAS_SAVED_RECIPE_STORAGE_KEY);
const installPromptDismissed = createStorageFlag(INSTALL_PROMPT_DISMISSED_STORAGE_KEY);

/** Call after any successful save to the cookbook (importer, import queue, featured recipes). */
export const markRecipeSaved = (): void => {
  hasSavedRecipe.set();
};

export const dismissInstallPrompt = (): void => {
  installPromptDismissed.set();
};

export const useHasSavedRecipe = (): boolean => useStorageFlag(hasSavedRecipe);

export const useInstallPromptDismissed = (): boolean => useStorageFlag(installPromptDismissed);

export const resetInstallEligibilityForTests = (): void => {
  hasSavedRecipe.resetForTests();
  installPromptDismissed.resetForTests();
};
