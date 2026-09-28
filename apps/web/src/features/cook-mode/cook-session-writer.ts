import { endCookSession, updateCookSession } from "../../data/cook-session-store";

import type { CookSession, CookSessionPatch } from "../../data/cook-session-store";

/**
 * Every cook-session write from the recipe view, cook mode and the timer dock goes through this
 * per-recipe queue, so this tab's writes land in the order they were made and can be flushed.
 * Each write is a read-modify-write in one IndexedDB transaction, which is what keeps it from
 * overwriting another tab's (their queues are separate).
 */

const queues = new Map<string, Promise<unknown>>();

const enqueue = <Result>(recipeId: string, task: () => Promise<Result>): Promise<Result> => {
  const previous = queues.get(recipeId) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => undefined);
  queues.set(recipeId, settled);
  void settled.then(() => {
    if (queues.get(recipeId) === settled) {
      queues.delete(recipeId);
    }
  });
  return next;
};

export const queueCookSessionUpdate = (
  recipeId: string,
  patch: CookSessionPatch | ((session: CookSession) => CookSessionPatch)
): Promise<CookSession> => enqueue(recipeId, () => updateCookSession(recipeId, patch));

/**
 * Ends a cook for the recipe: forgets the step and ticked ingredients, but keeps the session
 * while timers are still running so they survive a reload.
 */
export const queueCookSessionReset = (recipeId: string): Promise<void> =>
  enqueue(recipeId, () => endCookSession(recipeId));

/** Resolves once every queued write has settled (tests and page-hide flushes). */
export const flushCookSessionWrites = async (): Promise<void> => {
  await Promise.all(Array.from(queues.values()));
};
