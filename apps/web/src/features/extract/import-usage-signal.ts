/**
 * Tells the importer's allowance to refresh. The import queue calls it after it imports links in
 * the background, since those imports don't go through the page's own session.
 */
let generation = 0;
const listeners = new Set<() => void>();

export const invalidateImportUsage = (): void => {
  generation += 1;
  listeners.forEach((listener) => {
    listener();
  });
};

export const subscribeImportUsage = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getImportUsageGeneration = (): number => generation;
