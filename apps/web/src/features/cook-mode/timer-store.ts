import { useSyncExternalStore } from "react";

import { trackWebEvent } from "../../analytics/client";
import { subscribeDataChanges } from "../../data/change-feed";
import {
  getCookSession,
  getCookSessions,
  getCookTimerRemainingMs,
  pauseCookTimer,
  resumeCookTimer,
  startCookTimer
} from "../../data/cook-session-store";
import {
  discardCookSessionWrites,
  getCookSessionWriteGeneration
} from "../../data/cook-session-write-guard";

import { queueCookSessionUpdate } from "./cook-session-writer";
import {
  flashDocumentTitle,
  playTimerChime,
  primeTimerAudio,
  requestTimerNotificationPermission,
  showTimerNotification,
  stopTitleFlash,
  vibrateForTimer
} from "./timer-alerts";

import type { CookSession, CookTimerState } from "../../data/cook-session-store";

/**
 * Kitchen timers for the whole app. They are started from recipe steps (on the recipe page or in
 * cook mode), shown in the TimerDock above the tab bar, keep running when cook mode closes or you
 * navigate, and are saved in each recipe's cook session so a reload brings them back.
 *
 * Several tabs can be open: each writes only the timers it changed (never its whole list, which
 * may be stale), picks up the other tabs' changes when they announce a write, and a finished
 * timer is claimed in storage so only one tab chimes and notifies.
 */

export interface KitchenTimer extends CookTimerState {
  /** Cook-session key of the recipe that started it (a saved recipe id or "featured:<slug>"). */
  recipeId: string;
  recipeTitle: string;
  /** Where "open recipe" goes (omitted when there is no page to return to). */
  href?: string | undefined;
  stepIndex?: number | undefined;
  /** Epoch ms when the timer was noticed as finished (set once, drives the "done" state). */
  doneAt?: number | undefined;
}

export interface StartTimerInput {
  recipeId: string;
  recipeTitle: string;
  label: string;
  durationMs: number;
  href?: string | undefined;
  stepIndex?: number | undefined;
}

/** Finished while the tab was closed for longer than this: shown as done, but not chimed. */
const STALE_COMPLETION_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_000_000;
/** Serializes completion claims across tabs (Web Locks), so one tab announces each timer. */
export const KITCHEN_TIMER_LOCK_NAME = "linkdish:kitchen-timers";

type Listener = () => void;

let timers: KitchenTimer[] = [];
let hydration: Promise<void> | null = null;
let completionTimeout: ReturnType<typeof setTimeout> | null = null;
let visibilityListening = false;
let idCounter = 0;
const listeners = new Set<Listener>();

/** Bumped on every change this tab makes, so a read from storage can tell it is out of date. */
let localEpoch = 0;
/** Timer writes (and completion claims) queued by this tab that have not landed yet. */
let pendingWrites = 0;
let reloadWanted = false;
let reloading = false;
let unsubscribeRemote: (() => void) | null = null;
let unsubscribeRecipeDeletions: (() => void) | null = null;
/** Timers this tab changed whose save failed: until one lands, only this tab knows them. */
const unsavedTimerIds = new Set<string>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

const createTimerId = (): string => {
  idCounter += 1;
  return `timer-${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 7)}`;
};

/** "4:05", "12:30", "1:02:09" */
export const formatTimerClock = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

/** "Step 3" when the timer came from a step, otherwise its label. */
export const getTimerContextLabel = (timer: Pick<KitchenTimer, "label" | "stepIndex">): string =>
  timer.stepIndex != null ? `Step ${timer.stepIndex + 1}` : timer.label;

export const getTimerRemainingMs = (timer: KitchenTimer, now: number = Date.now()): number =>
  getCookTimerRemainingMs(timer, now);

export const isTimerDone = (timer: KitchenTimer, now: number = Date.now()): boolean =>
  timer.doneAt != null || (!timer.paused && getCookTimerRemainingMs(timer, now) === 0);

/* ------------------------------------------------------------------------------------------------
 * Persistence
 * ---------------------------------------------------------------------------------------------- */

const toStoredTimer = (timer: KitchenTimer): KitchenTimer => ({ ...timer });

/** Runs a timer write through the recipe's session queue, counting it as pending until it lands. */
const trackWrite = <Result>(write: () => Promise<Result>): Promise<Result> => {
  pendingWrites += 1;

  return write().finally(() => {
    pendingWrites -= 1;
    reloadIfWanted();
  });
};

/**
 * Saves the timers this tab changed: `upserted` replace (or join) the stored ones with the same
 * id and `removedIds` leave; every other stored timer (another tab's, say) is kept as stored.
 */
const persistTimerChanges = (
  recipeId: string,
  change: { upserted?: readonly KitchenTimer[]; removedIds?: readonly string[] }
) => {
  const upserted = change.upserted ?? [];
  const removed = new Set(change.removedIds ?? []);

  // Saved timers are restored first, so the stored list this merges into is complete. The change
  // is made now, though queued after that: if its recipe is deleted meanwhile, it is dropped.
  const savedIds = upserted.map((timer) => timer.id);
  const generation = getCookSessionWriteGeneration(recipeId);
  void trackWrite(() =>
    (hydration ?? Promise.resolve()).then(() =>
      queueCookSessionUpdate(
        recipeId,
        (session) => {
          const replacements = new Map(upserted.map((timer) => [timer.id, toStoredTimer(timer)]));
          const next: CookTimerState[] = session.timers
            .filter((stored) => !removed.has(stored.id))
            .map((stored) => replacements.get(stored.id) ?? stored);
          const storedIds = new Set(session.timers.map((stored) => stored.id));

          replacements.forEach((timer, id) => {
            if (!storedIds.has(id)) {
              next.push(timer);
            }
          });

          return { timers: next };
        },
        { generation }
      )
    )
  ).then(
    () => savedIds.forEach((id) => unsavedTimerIds.delete(id)),
    (error: unknown) => {
      savedIds.forEach((id) => unsavedTimerIds.add(id));
      console.warn("Could not save kitchen timers.", error);
    }
  );
};

const setTimers = (
  next: KitchenTimer[],
  change: { recipeId: string; upserted?: readonly KitchenTimer[]; removedIds?: readonly string[] }
) => {
  timers = next;
  localEpoch += 1;
  scheduleCompletionCheck();
  emit();
  persistTimerChanges(change.recipeId, change);
};

const isKitchenTimer = (value: unknown): value is CookTimerState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CookTimerState).id === "string" &&
  typeof (value as CookTimerState).durationMs === "number";

const fromStoredTimer = (stored: CookTimerState, recipeId: string): KitchenTimer => {
  const extra = stored as Partial<KitchenTimer>;

  return {
    ...stored,
    recipeId,
    recipeTitle: extra.recipeTitle || "Kitchen timer",
    ...(extra.href ? { href: extra.href } : {}),
    ...(extra.stepIndex != null ? { stepIndex: extra.stepIndex } : {}),
    ...(extra.doneAt != null ? { doneAt: extra.doneAt } : {})
  };
};

const storedTimersOf = (sessions: Map<string, CookSession>): KitchenTimer[] => {
  const stored: KitchenTimer[] = [];

  for (const session of sessions.values()) {
    for (const timer of session.timers ?? []) {
      if (isKitchenTimer(timer)) {
        stored.push(fromStoredTimer(timer, session.recipeId));
      }
    }
  }

  return stored;
};

/**
 * Another tab changed cook sessions: adopt the stored timers (in this tab's order, new ones last).
 * Waits until this tab's own writes have landed and retries when this tab changed something
 * while reading, so a local change is never dropped.
 */
function reloadIfWanted(): void {
  if (!reloadWanted || reloading || pendingWrites > 0) {
    return;
  }

  reloadWanted = false;
  reloading = true;
  const epoch = localEpoch;

  void getCookSessions()
    .then((sessions) => {
      if (epoch !== localEpoch || pendingWrites > 0) {
        reloadWanted = true;
        return;
      }

      const stored = new Map(storedTimersOf(sessions).map((timer) => [timer.id, timer]));
      const next: KitchenTimer[] = [];

      for (const timer of timers) {
        const current = stored.get(timer.id);

        if (current) {
          next.push(current);
          stored.delete(timer.id);
        }
      }

      stored.forEach((timer) => next.push(timer));
      timers = next;
      checkCompletions({ silentIfStale: true });

      if (!timers.some((timer) => timer.doneAt != null)) {
        stopTitleFlash();
      }

      scheduleCompletionCheck();
      emit();
    })
    .catch((error: unknown) => {
      console.warn("Could not refresh kitchen timers.", error);
    })
    .finally(() => {
      reloading = false;
      reloadIfWanted();
    });
}

function listenForOtherTabs(): void {
  unsubscribeRemote ??= subscribeDataChanges("cookSessions", (change, source) => {
    // Also this tab deleting sessions (a deleted recipe takes its session and timers with it),
    // so the dock never keeps a countdown whose stored timer is gone and could never be claimed.
    // This store's own writes only ever upsert, so they don't come back here.
    if (source === "remote" || change.reload || (change.deletedIds?.length ?? 0) > 0) {
      reloadWanted = true;
      reloadIfWanted();
    }
  });
  // Another tab deleted these recipes (their cook sessions with them): timer changes this tab
  // hasn't saved for them yet are dropped instead of creating those sessions again. (This tab's
  // own deletions hold them back themselves, see deleteSavedRecipe.)
  unsubscribeRecipeDeletions ??= subscribeDataChanges("savedRecipes", (change, source) => {
    if (source === "remote") {
      change.deletedIds?.forEach(discardCookSessionWrites);
    }
  });
}

/**
 * Loads timers saved in cook sessions (once per page load, once it has worked: a failed read is
 * tried again by the next call, e.g. a timer started or the page shown again). Never rejects.
 */
export const hydrateKitchenTimers = (): Promise<void> => {
  listenForOtherTabs();

  if (!hydration) {
    const attempt: Promise<void> = getCookSessions()
      .then((sessions) => {
        const known = new Set(timers.map((timer) => timer.id));
        const restored = storedTimersOf(sessions).filter((timer) => !known.has(timer.id));

        if (restored.length > 0) {
          timers = [...timers, ...restored];
          checkCompletions({ silentIfStale: true });
          scheduleCompletionCheck();
          emit();
        }
      })
      .catch((error: unknown) => {
        console.warn("Could not restore kitchen timers.", error);

        if (hydration === attempt) {
          hydration = null;
        }
      });
    hydration = attempt;
  }

  ensureVisibilityListener();
  return hydration;
};

/* ------------------------------------------------------------------------------------------------
 * Completion
 * ---------------------------------------------------------------------------------------------- */

const announce = (timer: KitchenTimer) => {
  playTimerChime();
  vibrateForTimer();
  flashDocumentTitle(`⏰ Timer done: ${getTimerContextLabel(timer)}`);
  void showTimerNotification({
    body: `${timer.recipeTitle} · ${getTimerContextLabel(timer)}`,
    tag: `linkdish-timer-${timer.id}`,
    title: `Your ${timer.label} timer is done`
  });
};

/** Runs `task` holding the kitchen-timer lock across tabs (directly where Web Locks are missing). */
const withTimerLock = <Result>(task: () => Promise<Result>): Promise<Result> => {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;

  if (!locks?.request) {
    return task();
  }

  return locks.request(KITCHEN_TIMER_LOCK_NAME, task) as Promise<Result>;
};

/**
 * Records the finish in storage. True when this tab is the first to notice it (and so announces
 * it); false when another tab already did, or the timer was dismissed there.
 */
const claimCompletion = (timer: KitchenTimer): Promise<boolean> =>
  trackWrite(async () => {
    await (hydration ?? Promise.resolve());

    return withTimerLock(async () => {
      const isClaimable = (session: CookSession | undefined) => {
        const stored = session?.timers.find((entry) => entry.id === timer.id) as
          | Partial<KitchenTimer>
          | undefined;
        return stored !== undefined && stored.doneAt == null;
      };

      const stored = await getCookSession(timer.recipeId);

      if (!isClaimable(stored)) {
        // Never saved (its first write failed): no other tab knows it, so this one announces it
        // while it still counts it down.
        return (
          !stored?.timers.some((entry) => entry.id === timer.id) &&
          unsavedTimerIds.has(timer.id) &&
          timers.some((entry) => entry.id === timer.id)
        );
      }

      let claimed = false;

      await queueCookSessionUpdate(timer.recipeId, (session) => {
        if (!isClaimable(session)) {
          return {};
        }

        claimed = true;
        return {
          timers: session.timers.map((entry) =>
            entry.id === timer.id ? { ...entry, doneAt: timer.doneAt } : entry
          )
        };
      });

      return claimed;
    });
  });

/** Marks finished timers as done and announces them. Returns true when something finished. */
const checkCompletions = ({ silentIfStale = false } = {}): boolean => {
  const now = Date.now();
  const finished: KitchenTimer[] = [];
  const next = timers.map((timer) => {
    if (timer.doneAt != null || timer.paused || getCookTimerRemainingMs(timer, now) > 0) {
      return timer;
    }

    const done = { ...timer, doneAt: now };
    finished.push(done);
    return done;
  });

  if (finished.length === 0) {
    return false;
  }

  timers = next;
  localEpoch += 1;

  for (const timer of finished) {
    const endedAt = timer.endsAt ?? now;
    const fresh = !silentIfStale || now - endedAt <= STALE_COMPLETION_MS;

    void claimCompletion(timer).then(
      (claimed) => {
        if (claimed && fresh) {
          announce(timer);
        }
      },
      (error: unknown) => {
        // Storage trouble: still tell the cook their timer is done.
        console.warn("Could not save a finished kitchen timer.", error);

        if (fresh) {
          announce(timer);
        }
      }
    );
  }

  return true;
};

function scheduleCompletionCheck(): void {
  if (completionTimeout) {
    clearTimeout(completionTimeout);
    completionTimeout = null;
  }

  const now = Date.now();
  const nextEnd = timers
    .filter((timer) => timer.doneAt == null && !timer.paused && timer.endsAt != null)
    .reduce<
      number | null
    >((earliest, timer) => (earliest == null || timer.endsAt! < earliest ? timer.endsAt! : earliest), null);

  if (nextEnd == null) {
    return;
  }

  completionTimeout = setTimeout(
    () => {
      completionTimeout = null;

      if (checkCompletions()) {
        emit();
      }

      scheduleCompletionCheck();
    },
    Math.min(MAX_TIMEOUT_MS, Math.max(0, nextEnd - now))
  );
}

function ensureVisibilityListener(): void {
  if (visibilityListening || typeof document === "undefined") {
    return;
  }

  visibilityListening = true;
  // Background tabs throttle timeouts; catch up as soon as the page is visible again (and read
  // the saved timers, if that failed so far).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      return;
    }

    if (!hydration) {
      void hydrateKitchenTimers();
    }

    if (checkCompletions()) {
      emit();
      scheduleCompletionCheck();
    }
  });
}

/* ------------------------------------------------------------------------------------------------
 * Actions
 * ---------------------------------------------------------------------------------------------- */

const updateTimer = (id: string, update: (timer: KitchenTimer) => KitchenTimer | null) => {
  const current = timers.find((timer) => timer.id === id);

  if (!current) {
    return;
  }

  const updated = update(current);
  const next = updated
    ? timers.map((timer) => (timer.id === id ? updated : timer))
    : timers.filter((timer) => timer.id !== id);

  setTimers(
    next,
    updated
      ? { recipeId: current.recipeId, upserted: [updated] }
      : { recipeId: current.recipeId, removedIds: [id] }
  );
};

/** Starts a timer (asks for notification permission on the very first one). Returns its id. */
export const startKitchenTimer = (input: StartTimerInput): string => {
  primeTimerAudio();
  requestTimerNotificationPermission();
  ensureVisibilityListener();
  void hydrateKitchenTimers();

  const timer: KitchenTimer = {
    ...startCookTimer({
      durationMs: Math.max(1000, Math.round(input.durationMs)),
      id: createTimerId(),
      label: input.label
    }),
    recipeId: input.recipeId,
    recipeTitle: input.recipeTitle,
    ...(input.href ? { href: input.href } : {}),
    ...(input.stepIndex != null ? { stepIndex: input.stepIndex } : {})
  };

  setTimers([...timers, timer], { recipeId: input.recipeId, upserted: [timer] });
  trackWebEvent({
    eventName: "cook_timer_started",
    properties: {
      duration_seconds: Math.round(timer.durationMs / 1000),
      from_step: input.stepIndex != null
    },
    routeOrScreen: window.location.pathname
  });
  return timer.id;
};

export const pauseKitchenTimer = (id: string): void =>
  updateTimer(id, (timer) =>
    timer.doneAt != null ? timer : { ...timer, ...pauseCookTimer(timer), endsAt: undefined }
  );

export const resumeKitchenTimer = (id: string): void =>
  updateTimer(id, (timer) => {
    const resumed = resumeCookTimer(timer);
    return { ...timer, ...resumed, remainingMs: undefined };
  });

/** Adds time; on a finished timer it starts a fresh countdown ("1 more minute"). */
export const addKitchenTimerTime = (id: string, ms: number = 60_000): void => {
  primeTimerAudio();
  updateTimer(id, (timer) => {
    const now = Date.now();

    if (timer.doneAt != null) {
      stopTitleFlash();
      return {
        ...timer,
        doneAt: undefined,
        durationMs: ms,
        endsAt: now + ms,
        paused: false,
        remainingMs: undefined
      };
    }

    if (timer.paused) {
      return {
        ...timer,
        durationMs: timer.durationMs + ms,
        remainingMs: getCookTimerRemainingMs(timer, now) + ms
      };
    }

    return { ...timer, durationMs: timer.durationMs + ms, endsAt: (timer.endsAt ?? now) + ms };
  });
};

export const dismissKitchenTimer = (id: string): void => {
  updateTimer(id, () => null);

  if (!timers.some((timer) => timer.doneAt != null)) {
    stopTitleFlash();
  }
};

export const getKitchenTimers = (): readonly KitchenTimer[] => timers;

export const subscribeKitchenTimers = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Every running, paused and finished timer (finished ones stay until dismissed). */
export const useKitchenTimers = (): readonly KitchenTimer[] =>
  useSyncExternalStore(subscribeKitchenTimers, getKitchenTimers, getKitchenTimers);

/** Test seam. */
export const resetKitchenTimersForTests = (): void => {
  if (completionTimeout) {
    clearTimeout(completionTimeout);
    completionTimeout = null;
  }

  timers = [];
  hydration = null;
  idCounter = 0;
  localEpoch = 0;
  pendingWrites = 0;
  reloadWanted = false;
  reloading = false;
  unsubscribeRemote?.();
  unsubscribeRemote = null;
  unsubscribeRecipeDeletions?.();
  unsubscribeRecipeDeletions = null;
  unsavedTimerIds.clear();
  emit();
};
