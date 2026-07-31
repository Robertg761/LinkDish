type ResetListener = () => void;

const resetListeners = new Set<ResetListener>();

export const requestRecipeUrlReset = () => {
  for (const listener of resetListeners) {
    listener();
  }
};

export const subscribeToRecipeUrlReset = (listener: ResetListener) => {
  resetListeners.add(listener);

  return () => {
    resetListeners.delete(listener);
  };
};
