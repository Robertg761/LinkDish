type RecipeBookBounceListener = () => void;

const listeners = new Set<RecipeBookBounceListener>();
let pendingBounce = false;

/** The Cookbook tab icon subscribes here; returns the unsubscribe function. */
export const subscribeToRecipeBookBounce = (listener: RecipeBookBounceListener) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/** Bounces the Cookbook tab icon now. */
export const triggerRecipeBookBounce = () => {
  listeners.forEach((listener) => listener());
};

/**
 * Asks for a bounce the next time the tab bar is in view. A recipe is saved on the pushed
 * /recipe screen, which covers the tab bar, so bouncing right away would play unseen.
 */
export const requestRecipeBookBounce = () => {
  pendingBounce = true;
};

/** Plays a requested bounce, if any (called when a tab screen regains focus). */
export const flushRecipeBookBounce = (): boolean => {
  if (!pendingBounce) {
    return false;
  }

  pendingBounce = false;
  triggerRecipeBookBounce();
  return true;
};
