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

/** Deletes every expired session. Returns how many were removed. */
export async function cleanupExpiredCookSessions(now: number = Date.now()): Promise<number> {
  const db = await getLinkDishWebDb();
  const sessions = (await db.getAll(COOK_SESSIONS_STORE_NAME)) as CookSession[];
  const expired = sessions.filter((session) => isCookSessionExpired(session, now));

  if (!expired.length) {
    return 0;
  }

  const tx = db.transaction(COOK_SESSIONS_STORE_NAME, "readwrite");
  const store = tx.objectStore(COOK_SESSIONS_STORE_NAME);
  await Promise.all([...expired.map((session) => store.delete(session.recipeId)), tx.done]);
  emitDataChange({
    deletedIds: expired.map((session) => session.recipeId),
    topic: "cookSessions"
  });
  return expired.length;
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
    await clearCookSession(recipeId);
    return undefined;
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

/** Merges `patch` into the recipe's live session, starting a fresh one when there is none. */
export async function updateCookSession(
  recipeId: string,
  patch: CookSessionPatch | ((session: CookSession) => CookSessionPatch),
  now: number = Date.now()
): Promise<CookSession> {
  const current = (await getCookSession(recipeId, now)) ?? createEmptyCookSession(recipeId, now);
  const changes = typeof patch === "function" ? patch(current) : patch;
  return saveCookSession({ ...current, ...changes, recipeId }, now);
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
