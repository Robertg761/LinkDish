import { createStepIngredientMatcher, parseStepDurations } from "@linkdish/recipe-domain";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { trackWebEvent } from "../../analytics/client";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useToast } from "../../components/Toast";
import { useBodyScrollLock } from "../../components/use-body-scroll-lock";
import { useModalFocusTrap } from "../../components/use-modal-focus-trap";
import { useCookSession } from "../../data/cook-session-store";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { usePreference } from "../../preferences/preferences-store";
import { IngredientList } from "../recipe-view/IngredientList";
import { sortRecipeSteps } from "../recipe-view/MethodList";
import { useRecipeScaling } from "../recipe-view/recipe-scaling";
import { RecipeScaleBar } from "../recipe-view/RecipeScaleBar";
import { formatStepTimerLabel, getStepTimerSeconds } from "../recipe-view/step-timers";
import { groupRecipeIngredients, useIngredientChecks } from "../recipe-view/use-ingredient-checks";

import { queueCookSessionReset, queueCookSessionUpdate } from "./cook-session-writer";
import { CookFinish } from "./CookFinish";
import { CookIngredientsSheet, CookSettingsSheet, CookStepsSheet } from "./CookSheets";
import { setTimerDockHost } from "./timer-dock-host";
import {
  formatTimerClock,
  getTimerRemainingMs,
  pauseKitchenTimer,
  resumeKitchenTimer,
  startKitchenTimer,
  useKitchenTimers
} from "./timer-store";
import { useStepSpeech } from "./use-step-speech";
import { useScreenWakeLock } from "./use-wake-lock";

import type { KitchenTimer } from "./timer-store";
import type { RecipeRating } from "../library/saved-recipe-types";
import type { RecipeScaling } from "../recipe-view/recipe-scaling";
import type { IngredientGroup } from "../recipe-view/use-ingredient-checks";
import type { ParsedStepDuration, Recipe } from "@linkdish/recipe-domain";

import "./CookMode.css";

const SWIPE_HORIZONTAL_DOMINANCE = 1.15;
const SWIPE_THRESHOLD = 36;
const TAP_MOVEMENT_TOLERANCE = 10;
const SYNTHETIC_CLICK_GUARD_MS = 500;
const NAVIGATION_LOCK_MS = 240;
const HINTS_STORAGE_KEY = "linkdish:web:cook-mode-hints-seen:v1";
const SPLIT_LAYOUT_QUERY = "(min-width: 768px)";
/** Keyboard hints only where there is likely a keyboard (not on a touch tablet). */
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export interface CookModeProps {
  open: boolean;
  onClose: () => void;
  recipe: Recipe;
  /**
   * Cook-session key (a saved recipe id, "featured:<slug>", …). Enables resuming where you left
   * off; ticked ingredients and timers are shared with the recipe page through it.
   */
  sessionKey?: string | null | undefined;
  /** Where the timer dock links back to. */
  recipeHref?: string | undefined;
  /** The page's scaling (so cook mode matches it); cook mode keeps its own otherwise. */
  scaling?: RecipeScaling | undefined;
  /** Analytics entry point for cook_mode_started. */
  entryPoint?: string | undefined;
  onAddIngredientsToShoppingList?: (() => void | Promise<void>) | undefined;
  /** Called once when the finish screen is reached. */
  onFinish?: (() => void | Promise<void>) | undefined;
  /** "Log this cook" on the finish screen (omit to hide it). */
  onLogCook?: ((entry: { note?: string | undefined }) => Promise<void>) | undefined;
  rating?: RecipeRating | null | undefined;
  onRate?: ((rating: RecipeRating | null) => void) | undefined;
}

const isDeliberateSwipe = (deltaX: number, deltaY: number): boolean =>
  Math.abs(deltaX) >= SWIPE_THRESHOLD &&
  Math.abs(deltaX) >= Math.abs(deltaY) * SWIPE_HORIZONTAL_DOMINANCE;

const TYPING_ROLES = new Set([
  "combobox",
  "listbox",
  "menuitem",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "textbox"
]);

/** Keys typed into fields, sliders or radio groups must never turn the page. */
const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]")) {
    return true;
  }

  const role = target.getAttribute("role");
  return role != null && TYPING_ROLES.has(role);
};

/** The swipe/tap hints only make sense on touch screens (desktop has the ← → hint). */
const isCoarsePointer = (): boolean => {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
};

const readHintsSeen = (): boolean => {
  try {
    return localStorage.getItem(HINTS_STORAGE_KEY) === "true";
  } catch {
    return true;
  }
};

/**
 * Cook mode 2.0: one big, calm step at a time. Resumes where you left off, shares ticked
 * ingredients and timers with the recipe page, keeps the screen awake (re-acquired after
 * switching apps), can read steps aloud, and ends with a finish screen to rate and log the cook.
 * Phones get swipe/tap navigation and sheets; tablets and desktop a split layout with the
 * ingredients beside the step.
 */
export const CookMode: React.FC<CookModeProps> = ({
  open,
  onClose,
  recipe,
  sessionKey,
  recipeHref,
  scaling: scalingProp,
  entryPoint = "recipe_detail",
  onAddIngredientsToShoppingList,
  onFinish,
  onLogCook,
  rating,
  onRate
}) => {
  const steps = useMemo(() => sortRecipeSteps(recipe.steps), [recipe.steps]);
  const stepCount = steps.length;
  const ownScaling = useRecipeScaling(recipe);
  const scaling = scalingProp ?? ownScaling;
  const checks = useIngredientChecks(sessionKey);
  const { session, status: sessionStatus } = useCookSession(sessionKey ?? undefined);
  const groups = useMemo<IngredientGroup[]>(
    () => groupRecipeIngredients(recipe.ingredients),
    [recipe.ingredients]
  );
  const itemsByIndex = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const matcher = useMemo(
    () => createStepIngredientMatcher(recipe.ingredients),
    [recipe.ingredients]
  );
  const textSize = usePreference("cookTextSize");
  const keepScreenAwake = usePreference("keepScreenAwake");
  const isSplit = useMediaQuery(SPLIT_LAYOUT_QUERY);
  const isWide = useMediaQuery(RAIL_MEDIA_QUERY);
  const hasFinePointer = useMediaQuery(FINE_POINTER_QUERY);
  const timers = useKitchenTimers();
  const { showToast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [stepAnnouncement, setStepAnnouncement] = useState("");

  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<"cooking" | "resume" | "finish">("cooking");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [hintsVisible, setHintsVisible] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [ingredientsOpen, setIngredientsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  /** True once this opening has decided where to start (so the step is safe to save). */
  const [ready, setReady] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const focusNextAfterRenderRef = useRef(false);
  const announcedStepRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const reportedFinishRef = useRef(false);
  const navigationLockRef = useRef(0);
  const touchStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClickUntilRef = useRef(0);

  const timerKey = sessionKey ?? `recipe:${recipe.sourceUrl}`;
  const currentStep = steps[stepIndex];
  const currentText = currentStep ? scaling.displayStep(currentStep.text) : "";
  const currentDurations = useMemo(
    () => (currentStep ? parseStepDurations(currentStep.text) : []),
    [currentStep]
  );
  const currentIngredientKeys = useMemo(() => {
    if (!currentStep) {
      return new Set<string>();
    }

    return new Set(
      matcher(currentStep.text).flatMap((index) => {
        const item = itemsByIndex.find((entry) => entry.index === index);
        return item ? [item.key] : [];
      })
    );
  }, [currentStep, itemsByIndex, matcher]);
  const stepIngredientGroups = useMemo<IngredientGroup[]>(() => {
    const items = itemsByIndex.filter((item) => currentIngredientKeys.has(item.key));
    return items.length ? [{ items, key: "step", section: null }] : [];
  }, [currentIngredientKeys, itemsByIndex]);
  // This step's timers that are still counting (or paused), by chip label.
  const stepTimers = useMemo(() => {
    const byLabel = new Map<string, KitchenTimer>();

    for (const timer of timers) {
      if (timer.recipeId === timerKey && timer.stepIndex === stepIndex && timer.doneAt == null) {
        byLabel.set(timer.label, timer);
      }
    }

    return byLabel;
  }, [stepIndex, timerKey, timers]);
  const hasTickingStepTimer = [...stepTimers.values()].some((timer) => !timer.paused);
  const isLastStep = stepIndex >= stepCount - 1;
  const progress = phase === "finish" ? 1 : stepCount > 0 ? (stepIndex + 1) / stepCount : 0;

  useBodyScrollLock(open);
  useModalFocusTrap({ active: open, containerRef: dialogRef });
  useScreenWakeLock(open && keepScreenAwake);
  useStepSpeech(open && readAloud && phase === "cooking", currentText || null);

  // The step's timer chips count down with the dock (one clock, not "10 min · Running").
  useEffect(() => {
    if (!open || !hasTickingStepTimer) {
      return;
    }

    // Tick on whole seconds, like the dock, so the chip and the dock always show the same time.
    let timeoutId = 0;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      timeoutId = window.setTimeout(tick, 1000 - (current % 1000) + 5);
    };

    tick();
    return () => window.clearTimeout(timeoutId);
  }, [hasTickingStepTimer, open]);

  // One live region outside the (re-keyed) step card says where you are after each move; the
  // card itself is replaced on every step, so a region inside it would never be announced.
  useEffect(() => {
    if (!open || !ready || phase === "resume") {
      announcedStepRef.current = null;
      return;
    }

    const key = phase === "finish" ? "finish" : String(stepIndex);

    if (announcedStepRef.current === null) {
      // The dialog's own name is read when it opens; start announcing from the first move.
      announcedStepRef.current = key;
      return;
    }

    if (announcedStepRef.current === key) {
      return;
    }

    announcedStepRef.current = key;
    setStepAnnouncement(
      phase === "finish"
        ? "All done. Rate it and log your cook."
        : `Step ${stepIndex + 1} of ${stepCount}. ${currentText}`
    );
  }, [currentText, open, phase, ready, stepCount, stepIndex]);

  // Coming back from the finish screen, keep keyboard focus on the footer's Next/Finish button.
  useEffect(() => {
    if (focusNextAfterRenderRef.current && phase === "cooking") {
      focusNextAfterRenderRef.current = false;
      nextButtonRef.current?.focus({ preventScroll: true });
    }
  }, [phase]);

  // Let fixed UI (the timer dock) know cook mode covers the screen.
  useEffect(() => {
    if (!open) {
      return;
    }

    document.documentElement.classList.add("cook-mode-open");
    return () => document.documentElement.classList.remove("cook-mode-open");
  }, [open]);

  // Opening: report the start, then resume where the last cook left off (once the session loads).
  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      reportedFinishRef.current = false;
      setReady(false);
      setStepsOpen(false);
      setIngredientsOpen(false);
      setSettingsOpen(false);
      return;
    }

    if (initializedRef.current || (sessionKey && sessionStatus === "loading")) {
      return;
    }

    initializedRef.current = true;
    startedAtRef.current = Date.now();
    trackWebEvent({
      eventName: "cook_mode_started",
      routeOrScreen: "recipe",
      properties: {
        entry_point: entryPoint,
        step_count: stepCount
      }
    });

    const savedStep = session?.stepIndex ?? 0;
    const canResume = savedStep > 0 && savedStep < stepCount;
    setStepIndex(canResume ? savedStep : 0);
    setPhase(canResume ? "resume" : "cooking");
    setDirection(1);
    setHintsVisible(!canResume && isCoarsePointer() && !readHintsSeen());
    setReady(true);
  }, [entryPoint, open, session?.stepIndex, sessionKey, sessionStatus, stepCount]);

  // Remember the step so closing (or a reload) can resume here.
  useEffect(() => {
    if (!open || !ready || !sessionKey || phase !== "cooking") {
      return;
    }

    void queueCookSessionUpdate(sessionKey, { stepIndex }).catch(() => undefined);
  }, [open, phase, ready, sessionKey, stepIndex]);

  const lockNavigation = (): boolean => {
    const now = Date.now();

    if (now < navigationLockRef.current) {
      return false;
    }

    navigationLockRef.current = now + NAVIGATION_LOCK_MS;
    return true;
  };

  const finish = useCallback(() => {
    setPhase("finish");
    setDirection(1);

    if (reportedFinishRef.current) {
      return;
    }

    reportedFinishRef.current = true;
    const startedAt = startedAtRef.current;
    trackWebEvent({
      eventName: "cook_mode_completed",
      routeOrScreen: "recipe",
      properties: {
        ...(startedAt
          ? { elapsed_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)) }
          : {}),
        step_count: stepCount
      }
    });
    void Promise.resolve(onFinish?.()).catch((error: unknown) => {
      console.warn("Failed to record the finished cook.", error);
    });
  }, [onFinish, stepCount]);

  const goToStep = useCallback(
    (index: number) => {
      const target = Math.min(Math.max(index, 0), stepCount - 1);
      setDirection(target >= stepIndex ? 1 : -1);
      setStepIndex(target);
      setPhase("cooking");
    },
    [stepCount, stepIndex]
  );

  const goNext = useCallback(() => {
    if (phase !== "cooking" || !lockNavigation()) {
      return;
    }

    if (isLastStep) {
      finish();
      return;
    }

    setDirection(1);
    setStepIndex((current) => Math.min(current + 1, stepCount - 1));
  }, [finish, isLastStep, phase, stepCount]);

  const goPrevious = useCallback(() => {
    if (phase === "resume" || !lockNavigation()) {
      return;
    }

    if (phase === "finish") {
      setDirection(-1);
      setPhase("cooking");
      setStepIndex(stepCount - 1);
      return;
    }

    setDirection(-1);
    setStepIndex((current) => Math.max(current - 1, 0));
  }, [phase, stepCount]);

  const endCook = useCallback(() => {
    if (sessionKey) {
      void queueCookSessionReset(sessionKey).catch(() => undefined);
    }

    onClose();
  }, [onClose, sessionKey]);

  const handleLogCook = useCallback(
    async (entry: { note?: string | undefined }) => {
      if (!onLogCook) {
        return;
      }

      await onLogCook(entry);
      showToast({ icon: "check-circle", message: "Logged. Nice cooking!", tone: "success" });
      endCook();
    },
    [endCook, onLogCook, showToast]
  );

  const dismissHints = () => {
    try {
      localStorage.setItem(HINTS_STORAGE_KEY, "true");
    } catch {
      // Still dismissible without storage.
    }

    setHintsVisible(false);
  };

  // Keyboard: ← → move, Escape closes. Keys inside fields, radios, sliders or a sheet on top
  // are left alone (typing "1.5" into the scale box used to flip steps).
  const keyHandlersRef = useRef({ goNext, goPrevious, onClose });
  keyHandlersRef.current = { goNext, goPrevious, onClose };

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const container = dialogRef.current;
      const active = document.activeElement;

      if (active && active !== document.body && container && !container.contains(active)) {
        return;
      }

      if (isTypingTarget(event.target) || isTypingTarget(active)) {
        return;
      }

      if (event.key === "Escape") {
        keyHandlersRef.current.onClose();
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        keyHandlersRef.current.goNext();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        keyHandlersRef.current.goPrevious();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    touchStartRef.current = touch ? { moved: false, x: touch.pageX, y: touch.pageY } : null;
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    const touch = event.changedTouches[0];

    if (
      start &&
      touch &&
      (Math.abs(touch.pageX - start.x) > TAP_MOVEMENT_TOLERANCE ||
        Math.abs(touch.pageY - start.y) > TAP_MOVEMENT_TOLERANCE)
    ) {
      start.moved = true;
    }
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    const touch = event.changedTouches[0];
    touchStartRef.current = null;

    if (!start || !touch) {
      return;
    }

    const deltaX = touch.pageX - start.x;
    const deltaY = touch.pageY - start.y;

    if (
      start.moved ||
      Math.abs(deltaX) > TAP_MOVEMENT_TOLERANCE ||
      Math.abs(deltaY) > TAP_MOVEMENT_TOLERANCE
    ) {
      suppressClickUntilRef.current = Date.now() + SYNTHETIC_CLICK_GUARD_MS;
    }

    if (!isDeliberateSwipe(deltaX, deltaY)) {
      return;
    }

    if (deltaX < 0) {
      goNext();
    } else {
      goPrevious();
    }
  };

  // Tapping the outer thirds of the step turns the page (like the Android app).
  const handleStepAreaClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressClickUntilRef.current || phase !== "cooking") {
      return;
    }

    if (
      event.target instanceof Element &&
      event.target.closest("button, input, textarea, label, a, [role='checkbox']")
    ) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = event.clientX - bounds.left;

    if (bounds.width <= 0) {
      return;
    }

    if (relativeX <= bounds.width / 3) {
      goPrevious();
    } else if (relativeX >= (bounds.width * 2) / 3) {
      goNext();
    }
  };

  const startStepTimer = (duration: ParsedStepDuration) => {
    const label = formatStepTimerLabel(duration);
    const existing = stepTimers.get(label);

    // A running chip pauses (and resumes) its timer instead of starting a second one.
    if (existing) {
      if (existing.paused) {
        resumeKitchenTimer(existing.id);
      } else {
        pauseKitchenTimer(existing.id);
      }

      return;
    }

    startKitchenTimer({
      durationMs: getStepTimerSeconds(duration) * 1000,
      href: recipeHref,
      label,
      recipeId: timerKey,
      recipeTitle: recipe.title,
      stepIndex
    });
  };

  if (!open || stepCount === 0) {
    return null;
  }

  const stepCard =
    phase === "finish" ? (
      <div
        className="cook-step-card is-finish"
        key="finish"
        style={{ "--cook-direction": direction } as React.CSSProperties}
      >
        <CookFinish
          onAddIngredientsToShoppingList={onAddIngredientsToShoppingList}
          onBack={() => {
            focusNextAfterRenderRef.current = true;
            goPrevious();
          }}
          onDone={endCook}
          onLogCook={onLogCook ? handleLogCook : undefined}
          onRate={onRate}
          rating={rating}
          recipeTitle={recipe.title}
        />
      </div>
    ) : (
      <div
        className="cook-step-card"
        key={`step-${stepIndex}`}
        style={{ "--cook-direction": direction } as React.CSSProperties}
      >
        <p className="cook-step-eyebrow">
          Step <span className="num">{stepIndex + 1}</span>
          <span className="cook-step-of"> of {stepCount}</span>
        </p>
        <p className="cook-step-text">{currentText}</p>
        {currentDurations.length > 0 ? (
          <div aria-label="Step timers" className="cook-step-timers" role="group">
            {currentDurations.map((duration, index) => {
              const label = formatStepTimerLabel(duration);
              const timer = stepTimers.get(label);
              const paused = timer?.paused === true;

              return (
                <button
                  aria-label={
                    timer ? `${paused ? "Resume" : "Pause"} ${label} timer` : `Start ${label} timer`
                  }
                  className={`cook-timer-button${timer ? " is-running" : ""}${
                    paused ? " is-paused" : ""
                  }`}
                  key={`${label}-${index}`}
                  onClick={() => startStepTimer(duration)}
                  type="button"
                >
                  <Icon
                    name={timer ? (paused ? "play" : "pause") : "timer"}
                    size={20}
                    strokeWidth={2.2}
                  />
                  <span className="num">
                    {timer ? formatTimerClock(getTimerRemainingMs(timer, now)) : label}
                  </span>
                  <span className="cook-timer-button-state">
                    {timer ? (paused ? "Paused" : "left") : "Start timer"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {stepIngredientGroups.length > 0 && !isSplit ? (
          <div className="cook-step-ingredients">
            <p className="cook-step-ingredients-title">For this step</p>
            <IngredientList
              checked={checks.checked}
              displayIngredient={scaling.displayIngredient}
              groups={stepIngredientGroups}
              onToggle={checks.toggle}
            />
          </div>
        ) : null}
      </div>
    );

  const modal = (
    <div
      aria-label={`Cooking mode for ${recipe.title}`}
      aria-modal="true"
      className={`cook-mode cook-text-${textSize}${isSplit ? " is-split" : ""}`}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="cook-mode-header">
        <IconButton aria-label="Close cooking mode" icon="x" onClick={onClose} variant="tonal" />
        <div className="cook-mode-heading">
          <p className="cook-mode-title">{recipe.title}</p>
          {/* The step count lives in the step itself; the header only notes a changed yield. */}
          {phase !== "finish" && scaling.isModified && scaling.servingsLabel ? (
            <p className="cook-mode-subtitle num">{scaling.servingsLabel}</p>
          ) : null}
        </div>
        <div className="cook-mode-header-actions">
          <IconButton
            aria-label="All steps"
            icon="list"
            onClick={() => setStepsOpen(true)}
            variant="ghost"
          />
          <IconButton
            aria-label="Cook mode settings"
            icon="text-size"
            onClick={() => setSettingsOpen(true)}
            variant="ghost"
          />
        </div>
      </header>

      <div
        aria-label="Progress"
        aria-valuemax={stepCount}
        aria-valuemin={0}
        aria-valuenow={phase === "finish" ? stepCount : stepIndex + 1}
        className="cook-mode-progress"
        role="progressbar"
      >
        {stepCount <= 24 ? (
          Array.from({ length: stepCount }, (_, index) => (
            <span
              className={`cook-mode-progress-segment${
                phase === "finish" || index < stepIndex
                  ? " is-done"
                  : index === stepIndex
                    ? " is-current"
                    : ""
              }`}
              key={index}
            />
          ))
        ) : (
          <span className="cook-mode-progress-fill" style={{ width: `${progress * 100}%` }} />
        )}
      </div>

      <div className="cook-mode-body">
        {isSplit ? (
          <aside aria-label="Ingredients" className="cook-mode-ingredients-panel">
            <div className="cook-mode-panel-header">
              <h2 className="cook-mode-panel-title">Ingredients</h2>
              {scaling.servingsLabel ? (
                <span className="cook-mode-panel-meta num">{scaling.servingsLabel}</span>
              ) : null}
            </div>
            {isWide ? <RecipeScaleBar compact scaling={scaling} /> : null}
            <IngredientList
              checked={checks.checked}
              className="cook-mode-panel-list"
              displayIngredient={scaling.displayIngredient}
              groups={groups}
              highlightLabel={`Used in step ${stepIndex + 1}`}
              highlighted={phase === "cooking" ? currentIngredientKeys : undefined}
              onToggle={checks.toggle}
            />
          </aside>
        ) : null}

        <div
          className="cook-mode-step-area"
          onClick={handleStepAreaClick}
          onTouchEnd={handleTouchEnd}
          onTouchMove={handleTouchMove}
          onTouchStart={handleTouchStart}
        >
          <div className="cook-mode-step-scroller">{stepCard}</div>

          {phase === "resume" ? (
            <div className="cook-resume" role="group" aria-labelledby="cook-resume-title">
              <div className="cook-resume-card">
                <span aria-hidden="true" className="cook-resume-icon">
                  <Icon name="rotate-ccw" size={24} />
                </span>
                <h2 className="cook-resume-title" id="cook-resume-title">
                  Pick up where you left off?
                </h2>
                <p className="cook-resume-text">
                  You were on step <span className="num">{stepIndex + 1}</span> of{" "}
                  <span className="num">{stepCount}</span>. Your ticked ingredients and timers are
                  still here.
                </p>
                <div className="cook-resume-actions">
                  <Button fullWidth onClick={() => setPhase("cooking")} size="lg">
                    Resume at step {stepIndex + 1}
                  </Button>
                  <Button
                    fullWidth
                    onClick={() => {
                      setDirection(-1);
                      setStepIndex(0);
                      setPhase("cooking");
                    }}
                    variant="ghost"
                  >
                    Start over
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {hintsVisible && phase === "cooking" ? (
            <div className="cook-hints" role="status">
              <div className="cook-hint">
                <Icon name="arrow-left" size={18} />
                <Icon name="arrow-right" size={18} />
                <p>Tap the sides to move through steps.</p>
              </div>
              <div className="cook-hint">
                <Icon name="check-circle" size={18} />
                <p>Tap ingredients to check them off.</p>
              </div>
              <button className="cook-hints-dismiss" onClick={dismissHints} type="button">
                Got it
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <p aria-atomic="true" aria-live="polite" className="sr-only">
        {stepAnnouncement}
      </p>

      {/* The finish screen has its own actions (and "Back to steps"), so the footer steps aside. */}
      <footer className="cook-mode-footer" hidden={phase === "finish"}>
        {/* Always there, so the footer never jumps and focus never drops on step 1. */}
        <IconButton
          aria-disabled={phase !== "cooking" || stepIndex === 0 ? true : undefined}
          aria-label="Previous step"
          className="cook-mode-prev"
          icon="arrow-left"
          iconSize={24}
          onClick={() => {
            if (phase === "cooking" && stepIndex > 0) {
              goPrevious();
            }
          }}
          size="lg"
          variant="outline"
        />

        {!isSplit ? (
          <button
            aria-label="Show all ingredients"
            className="cook-mode-ingredients-button"
            onClick={() => setIngredientsOpen(true)}
            type="button"
          >
            <Icon name="list-checks" size={18} />
            <span>Ingredients</span>
            {checks.checked.size > 0 ? (
              <span className="cook-mode-ingredients-count num">
                {Math.min(checks.checked.size, recipe.ingredients.length)}/
                {recipe.ingredients.length}
              </span>
            ) : null}
          </button>
        ) : hasFinePointer ? (
          <span className="cook-mode-footer-hint">
            <kbd>←</kbd> <kbd>→</kbd> to move between steps
          </span>
        ) : (
          <span className="cook-mode-footer-hint">Swipe to move between steps</span>
        )}

        <Button
          aria-label={isLastStep ? "Finish cooking" : "Next step"}
          className="cook-mode-next"
          disabled={phase !== "cooking"}
          icon={isLastStep ? "check" : undefined}
          onClick={goNext}
          ref={nextButtonRef}
          size="lg"
          trailingIcon={isLastStep ? undefined : "arrow-right"}
          variant={isLastStep ? "accent" : "primary"}
        >
          {isLastStep ? "Finish" : "Next"}
        </Button>
      </footer>

      {/* Kitchen timers move in here while cooking (inside the dialog's focus trap). */}
      <div className="cook-mode-timer-slot" ref={setTimerDockHost} />

      <CookStepsSheet
        currentIndex={stepIndex}
        onClose={() => setStepsOpen(false)}
        onJump={(index) => {
          setStepsOpen(false);
          goToStep(index);
        }}
        open={stepsOpen}
        steps={steps.map((step) => scaling.displayStep(step.text))}
      />
      {!isSplit ? (
        <CookIngredientsSheet
          checks={checks}
          groups={groups}
          highlightLabel={`Used in step ${stepIndex + 1}`}
          highlighted={phase === "cooking" ? currentIngredientKeys : new Set()}
          onClose={() => setIngredientsOpen(false)}
          open={ingredientsOpen}
          scaling={scaling}
        />
      ) : null}
      <CookSettingsSheet
        onClose={() => setSettingsOpen(false)}
        onReadAloudChange={setReadAloud}
        open={settingsOpen}
        readAloud={readAloud}
      />
    </div>
  );

  return createPortal(modal, document.body);
};
