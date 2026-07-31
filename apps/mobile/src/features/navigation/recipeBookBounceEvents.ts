type RecipeBookBounceListener = () => void;

const listeners = new Set<RecipeBookBounceListener>();

export const subscribeToRecipeBookBounce = (listener: RecipeBookBounceListener) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export const triggerRecipeBookBounce = () => {
  listeners.forEach((listener) => listener());
};
