import { useSyncExternalStore } from "react";

import {
  getCookSessions,
  getCookTimerRemainingMs,
  pauseCookTimer,
  resumeCookTimer,
  startCookTimer
} from "../../data/cook-session-store";

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

import type { CookTimerState } from "../../data/cook-session-store";

/**
 * Kitchen timers for the whole app. They are started from recipe steps (on the recipe page or in
 * cook mode), shown in the TimerDock above the tab bar, keep running when cook mode closes or you
 * navigate, and are saved in each recipe's cook session so a reload brings them back.
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

type Listener = () => void;

let timers: KitchenTimer[] = [];
let hydration: Promise<void> | null = null;
let completionTimeout: ReturnType<typeof setTimeout> | null = null;
let visibilityListening = false;
let idCounter = 0;
const listeners = new Set<Listener>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

const createTimerId = (): string => {
  idCounter += 1;
  return `timer-${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 7)}`;
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

const persistRecipeTimers = (recipeId: string) => {
  // Wait for saved timers to be restored first, and read the list when the write runs, so a
  // timer started right after a reload never overwrites the ones still being restored.
  void (hydration ?? Promise.resolve())
    .then(() =>
      queueCookSessionUpdate(recipeId, () => ({
        timers: timers.filter((timer) => timer.recipeId === recipeId).map(toStoredTimer)
      }))
    )
    .catch((error: unknown) => {
      console.warn("Could not save kitchen timers.", error);
    });
};

const setTimers = (next: KitchenTimer[], changedRecipeIds: Iterable<string>) => {
  timers = next;
  scheduleCompletionCheck();
  emit();

  for (const recipeId of new Set(changedRecipeIds)) {
    persistRecipeTimers(recipeId);
  }
};

const isKitchenTimer = (value: unknown): value is CookTimerState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CookTimerState).id === "string" &&
  typeof (value as CookTimerState).durationMs === "number";

/** Loads timers saved in cook sessions (once per page load). Never rejects. */
export const hydrateKitchenTimers = (): Promise<void> => {
  hydration ??= getCookSessions()
    .then((sessions) => {
      const known = new Set(timers.map((timer) => timer.id));
      const restored: KitchenTimer[] = [];

      for (const session of sessions.values()) {
        for (const stored of session.timers ?? []) {
          if (!isKitchenTimer(stored) || known.has(stored.id)) {
            continue;
          }

          const extra = stored as Partial<KitchenTimer>;
          restored.push({
            ...stored,
            recipeId: session.recipeId,
            recipeTitle: extra.recipeTitle || "Kitchen timer",
            ...(extra.href ? { href: extra.href } : {}),
            ...(extra.stepIndex != null ? { stepIndex: extra.stepIndex } : {}),
            ...(extra.doneAt != null ? { doneAt: extra.doneAt } : {})
          });
        }
      }

      if (restored.length > 0) {
        timers = [...timers, ...restored];
        checkCompletions({ silentIfStale: true });
        scheduleCompletionCheck();
        emit();
      }
    })
    .catch((error: unknown) => {
      console.warn("Could not restore kitchen timers.", error);
    });

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

  for (const timer of finished) {
    const endedAt = timer.endsAt ?? now;

    if (!silentIfStale || now - endedAt <= STALE_COMPLETION_MS) {
      announce(timer);
    }
  }

  for (const recipeId of new Set(finished.map((timer) => timer.recipeId))) {
    persistRecipeTimers(recipeId);
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
  // Background tabs throttle timeouts; catch up as soon as the page is visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && checkCompletions()) {
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

  setTimers(next, [current.recipeId]);
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

  setTimers([...timers, timer], [input.recipeId]);
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
  emit();
};
