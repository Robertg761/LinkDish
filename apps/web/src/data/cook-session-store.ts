import { useCallback, useMemo } from "react";

import { COOK_SESSIONS_STORE_NAME, getLinkDishWebDb } from "../storage/linkdish-db";

import { emitDataChange } from "./change-feed";
import { createResourceStore, toViewStatus, useResource } from "./resource-store";

/**
 * Where you are in a recipe while cooking — step, ticked ingredients, running timers and scale —
 * so a reload, a tab switch or a phone lock does not lose your place. Sessions expire after 24h.
 */

export const COOK_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CookTimerState {
  id: string;
  label: string;
  durationMs: number;
  /** Epoch ms when a running timer finishes. Set while running. */
  endsAt?: number | undefined;
  /** Time left on a paused timer. Set while paused. */
  remainingMs?: number | undefined;
  paused: boolean;
}

export interface CookSession {
  recipeId: string;
  stepIndex: number;
  checkedIngredients: string[];
  timers: CookTimerState[];
  scale: number;
  unitPreference?: "primary" | "alternate" | undefined;
  updatedAt: string;
}

export type CookSessionPatch = Partial<Omit<CookSession, "recipeId" | "updatedAt">>;

/* ------------------------------------------------------------------------------------------------
 * Pure timer helpers
 * ---------------------------------------------------------------------------------------------- */

export const startCookTimer = (
  timer: { id: string; label: string; durationMs: number },
  now: number = Date.now()
): CookTimerState => ({
  durationMs: Math.max(0, timer.durationMs),
  endsAt: now + Math.max(0, timer.durationMs),
  id: timer.id,
  label: timer.label,
  paused: false
});

export const getCookTimerRemainingMs = (timer: CookTimerState, now: number = Date.now()) => {
  if (timer.paused) {
    return Math.max(0, timer.remainingMs ?? timer.durationMs);
  }

  return Math.max(0, (timer.endsAt ?? now) - now);
};

export const isCookTimerDone = (timer: CookTimerState, now: number = Date.now()) =>
  getCookTimerRemainingMs(timer, now) === 0;

export const pauseCookTimer = (timer: CookTimerState, now: number = Date.now()): CookTimerState =>
  timer.paused
    ? timer
    : {
        durationMs: timer.durationMs,
        id: timer.id,
        label: timer.label,
        paused: true,
        remainingMs: getCookTimerRemainingMs(timer, now)
      };

export const resumeCookTimer = (timer: CookTimerState, now: number = Date.now()): CookTimerState =>
  timer.paused
    ? {
        durationMs: timer.durationMs,
        endsAt: now + getCookTimerRemainingMs(timer, now),
        id: timer.id,
        label: timer.label,
        paused: false
      }
    : timer;

/* ------------------------------------------------------------------------------------------------
 * Storage
 * ---------------------------------------------------------------------------------------------- */

export const isCookSessionExpired = (session: CookSession, now: number = Date.now()): boolean => {
  const updatedAt = Date.parse(session.updatedAt);
  return !Number.isFinite(updatedAt) || now - updatedAt > COOK_SESSION_TTL_MS;
};

export const createEmptyCookSession = (
  recipeId: string,
  now: number = Date.now()
): CookSession => ({
  checkedIngredients: [],
  recipeId,
  scale: 1,
  stepIndex: 0,
  timers: [],
  updatedAt: new Date(now).toISOString()
});

const sanitizeSession = (session: CookSession): CookSession => ({
  ...session,
  checkedIngredients: Array.from(new Set(session.checkedIngredients)),
  scale: Number.isFinite(session.scale) && session.scale > 0 ? session.scale : 1,
  stepIndex: Number.isInteger(session.stepIndex) && session.stepIndex >= 0 ? session.stepIndex : 0
});

/**
 * Deletes those of `recipeIds` whose session is still expired, checking each again inside the
 * deleting readwrite transaction: another tab may have started a fresh session under that recipe
 * since it was read, and that one must stay. Returns the recipe ids actually deleted.
 */
async function deleteExpiredCookSessions(
  recipeIds: readonly string[],
  now: number
): Promise<string[]> {
  const db = await getLinkDishWebDb();
  const tx = db.transaction(COOK_SESSIONS_STORE_NAME, "readwrite");
  const store = tx.objectStore(COOK_SESSIONS_STORE_NAME);
  const deleted: string[] = [];
  const deleteIfExpired = async (recipeId: string) => {
    const session = (await store.get(recipeId)) as CookSession | undefined;

    if (session && isCookSessionExpired(session, now)) {
      deleted.push(recipeId);
      await store.delete(recipeId);
    }
  };

  await Promise.all([...recipeIds.map(deleteIfExpired), tx.done]);

  if (deleted.length) {
    emitDataChange({ deletedIds: deleted, topic: "cookSessions" });
  }

  return deleted;
}

/** Deletes every expired session. Returns how many were removed. */
export async function cleanupExpiredCookSessions(now: number = Date.now()): Promise<number> {
  const db = await getLinkDishWebDb();
  const sessions = (await db.getAll(COOK_SESSIONS_STORE_NAME)) as CookSession[];
  const expired = sessions.filter((session) => isCookSessionExpired(session, now));

  if (!expired.length) {
    return 0;
  }

  const deleted = await deleteExpiredCookSessions(
    expired.map((session) => session.recipeId),
    now
  );
  return deleted.length;
}

/** Every live session keyed by recipe id (expired ones are cleaned up first). */
export async function getCookSessions(now: number = Date.now()): Promise<Map<string, CookSession>> {
  await cleanupExpiredCookSessions(now);
  const db = await getLinkDishWebDb();
  const sessions = (await db.getAll(COOK_SESSIONS_STORE_NAME)) as CookSession[];
  return new Map(sessions.map((session) => [session.recipeId, session]));
}

/** The live session for a recipe, or `undefined` (an expired one is deleted). */
export async function getCookSession(
  recipeId: string,
  now: number = Date.now()
): Promise<CookSession | undefined> {
  const db = await getLinkDishWebDb();
  const session = (await db.get(COOK_SESSIONS_STORE_NAME, recipeId)) as CookSession | undefined;

  if (!session) {
    return undefined;
  }

  if (isCookSessionExpired(session, now)) {
    const deleted = await deleteExpiredCookSessions([recipeId], now);

    if (deleted.length) {
      return undefined;
    }

    // Another tab started a fresh session (or removed it) since the read above.
    const current = (await db.get(COOK_SESSIONS_STORE_NAME, recipeId)) as CookSession | undefined;
    return current && !isCookSessionExpired(current, now) ? current : undefined;
  }

  return session;
}

export async function saveCookSession(
  session: Omit<CookSession, "updatedAt">,
  now: number = Date.now()
): Promise<CookSession> {
  const next = sanitizeSession({ ...session, updatedAt: new Date(now).toISOString() });
  const db = await getLinkDishWebDb();
  await db.put(COOK_SESSIONS_STORE_NAME, next);
  emitDataChange({ topic: "cookSessions", upserted: [next] });
  return next;
}

/**
 * Merges `patch` into the recipe's live session, starting a fresh one when there is none (or it
 * has expired). The read and the write share one readwrite transaction, so IndexedDB serializes
 * them with other tabs' writes instead of letting one overwrite the other. `patch` must be
 * synchronous: awaiting anything else inside the transaction would let it commit early.
 */
export async function updateCookSession(
  recipeId: string,
  patch: CookSessionPatch | ((session: CookSession) => CookSessionPatch),
  now: number = Date.now(),
  /**
   * Checked in the write's own transaction, after any delete before it: false writes nothing
   * (the recipe was deleted since the change was made) and hands back the session as stored.
   */
  { isCurrent }: { isCurrent?: (() => boolean) | undefined } = {}
): Promise<CookSession> {
  const db = await getLinkDishWebDb();
  const tx = db.transaction(COOK_SESSIONS_STORE_NAME, "readwrite");
  const store = tx.objectStore(COOK_SESSIONS_STORE_NAME);
  const stored = (await store.get(recipeId)) as CookSession | undefined;
  const current =
    stored && !isCookSessionExpired(stored, now) ? stored : createEmptyCookSession(recipeId, now);

  if (isCurrent && !isCurrent()) {
    await tx.done;
    return current;
  }
  const changes = typeof patch === "function" ? patch(current) : patch;
  const next = sanitizeSession({
    ...current,
    ...changes,
    recipeId,
    updatedAt: new Date(now).toISOString()
  });

  await Promise.all([store.put(next), tx.done]);
  emitDataChange({ topic: "cookSessions", upserted: [next] });
  return next;
}

/**
 * Ends a cook for the recipe: forgets the step and ticked ingredients, but keeps the session
 * while timers are still running so they survive a reload. One transaction, like
 * {@link updateCookSession}, so a timer another tab starts meanwhile is never deleted.
 */
export async function endCookSession(recipeId: string, now: number = Date.now()): Promise<void> {
  const db = await getLinkDishWebDb();
  const tx = db.transaction(COOK_SESSIONS_STORE_NAME, "readwrite");
  const store = tx.objectStore(COOK_SESSIONS_STORE_NAME);
  const stored = (await store.get(recipeId)) as CookSession | undefined;

  if (!stored) {
    await tx.done;
    return;
  }

  if (!isCookSessionExpired(stored, now) && stored.timers.length > 0) {
    const next = sanitizeSession({
      ...stored,
      checkedIngredients: [],
      stepIndex: 0,
      updatedAt: new Date(now).toISOString()
    });
    await Promise.all([store.put(next), tx.done]);
    emitDataChange({ topic: "cookSessions", upserted: [next] });
    return;
  }

  await Promise.all([store.delete(recipeId), tx.done]);
  emitDataChange({ deletedIds: [recipeId], topic: "cookSessions" });
}

export async function clearCookSession(recipeId: string): Promise<void> {
  const db = await getLinkDishWebDb();
  await db.delete(COOK_SESSIONS_STORE_NAME, recipeId);
  emitDataChange({ deletedIds: [recipeId], topic: "cookSessions" });
}

const cookSessionsResource = createResourceStore<Map<string, CookSession>>({
  applyLocalChange: (current, change) => {
    const upserted = (change.upserted as CookSession[] | undefined) ?? [];
    const deleted = change.deletedIds ?? [];

    if (!upserted.length && !deleted.length) {
      return current;
    }

    const next = new Map(current);
    deleted.forEach((recipeId) => next.delete(recipeId));
    upserted.forEach((session) => next.set(session.recipeId, session));
    return next;
  },
  initial: new Map(),
  load: () => getCookSessions(),
  topic: "cookSessions"
});

export interface CookSessionView {
  error: unknown;
  retry: () => void;
  /** The live session, or `undefined` when there is none (or it has expired). */
  session: CookSession | undefined;
  status: "loading" | "ready" | "error";
}

export function useCookSession(recipeId: string | undefined): CookSessionView {
  const snapshot = useResource(cookSessionsResource);
  const retry = useCallback(() => {
    void cookSessionsResource.load({ force: true });
  }, []);
  const stored = recipeId ? snapshot.data.get(recipeId) : undefined;
  const session = stored && !isCookSessionExpired(stored) ? stored : undefined;

  return useMemo(
    () => ({
      error: snapshot.error,
      retry,
      session,
      status: toViewStatus(snapshot.status)
    }),
    [retry, session, snapshot.error, snapshot.status]
  );
}

export const loadCookSessions = (options?: { force?: boolean }): Promise<void> =>
  cookSessionsResource.load(options);

export function resetCookSessionStoreForTests(): void {
  cookSessionsResource.reset();
}
