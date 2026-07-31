import {
  matchStepIngredients,
  parseIngredientQuantity,
  parseStepDurations,
  scaleQuantity
} from "@linkdish/recipe-domain";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { trackWebEvent } from "../../analytics/client";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { Icon } from "../../components/Icon";
import {
  COOK_MODE_DONE_LABEL,
  COOK_MODE_FINALE_TITLE,
  getCookModeFinaleMessage
} from "../../lib/flavor-copy";

import type { ParsedIngredientQuantity, Recipe } from "@linkdish/recipe-domain";
import "./CookMode.css";

const COOK_MODE_SWIPE_HORIZONTAL_DOMINANCE = 1.15;
const COOK_MODE_SWIPE_THRESHOLD = 36;
const COOK_MODE_TAP_MOVEMENT_TOLERANCE = 10;
const COOK_MODE_SYNTHETIC_CLICK_GUARD_MS = 500;
const COOK_MODE_STEP_TRANSITION_DURATION_MS = 170;
const DEFAULT_TIMER_TITLE_FLASH_COUNT = 6;
const COOK_MODE_HINT_STORAGE_KEY = "linkdish:web:cook-mode-hints-seen:v1";

type UnitPreference = "primary" | "alternate";

export interface RecipeScalingState {
  customFactor: string;
  factor: number;
  unitPreference: UnitPreference;
}

interface ActiveCookTimer {
  completed: boolean;
  endsAt: number;
  id: string;
  label: string;
  stepNumber: number;
}

interface CookModeProps {
  onAddIngredientsToShoppingList?: () => void | Promise<void>;
  onFinish?: () => void | Promise<void>;
  onScalingChange?: React.Dispatch<React.SetStateAction<RecipeScalingState>>;
  recipe: Recipe;
  scaling?: RecipeScalingState;
}

interface RecipeScaleControlsProps {
  className?: string;
  hasAlternateUnits: boolean;
  hasUnscalableIngredients: boolean;
  onScalingChange: React.Dispatch<React.SetStateAction<RecipeScalingState>>;
  scaling: RecipeScalingState;
  unitLabels: {
    alternate: string;
    primary: string;
  };
}

export const DEFAULT_RECIPE_SCALING_STATE: RecipeScalingState = {
  customFactor: "1",
  factor: 1,
  unitPreference: "primary"
};

const isDeliberateHorizontalCookModeSwipe = (
  deltaX: number,
  deltaY: number,
  minimumDistance: number
): boolean => {
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);

  return (
    absoluteX >= minimumDistance && absoluteX >= absoluteY * COOK_MODE_SWIPE_HORIZONTAL_DOMINANCE
  );
};

const groupIngredients = (ingredients: Recipe["ingredients"]) => {
  const groups: Array<{
    ingredients: Array<{ key: string; text: string }>;
    key: string;
    section: string | null;
  }> = [];

  ingredients.forEach((ingredient, index) => {
    const section = ingredient.section?.trim() || null;
    const currentGroup = groups[groups.length - 1];

    if (!currentGroup || currentGroup.section !== section) {
      groups.push({
        ingredients: [],
        key: `${section ?? "ungrouped"}-${index}`,
        section
      });
    }

    groups[groups.length - 1]?.ingredients.push({
      key: `${index}-${ingredient.text}`,
      text: ingredient.text
    });
  });

  return groups;
};

const metricUnits = new Set(["g", "kg", "ml", "l"]);

const isMetricUnit = (unit: string | null) => (unit ? metricUnits.has(unit) : false);

export const getIngredientUnitLabels = (ingredients: Recipe["ingredients"]) => {
  const ingredientWithAlternate = ingredients
    .map((ingredient) => parseIngredientQuantity(ingredient.text))
    .find((parsed) => parsed.confident && parsed.altQty != null && parsed.altUnit);

  if (!ingredientWithAlternate) {
    return { alternate: "Metric", primary: "Imperial" };
  }

  return {
    alternate: isMetricUnit(ingredientWithAlternate.altUnit) ? "Metric" : "Imperial",
    primary: isMetricUnit(ingredientWithAlternate.unit) ? "Metric" : "Imperial"
  };
};

const getDisplayParsedIngredient = (
  parsed: ParsedIngredientQuantity,
  unitPreference: UnitPreference
): ParsedIngredientQuantity => {
  if (
    unitPreference !== "alternate" ||
    !parsed.confident ||
    parsed.altQty == null ||
    !parsed.altUnit
  ) {
    return parsed;
  }

  return {
    ...parsed,
    altQty: null,
    altUnit: null,
    qty: parsed.altQty,
    unit: parsed.altUnit
  };
};

export const hasAlternateIngredientUnits = (ingredients: Recipe["ingredients"]): boolean =>
  ingredients.some((ingredient) => {
    const parsed = parseIngredientQuantity(ingredient.text);

    return parsed.confident && parsed.altQty != null && parsed.altUnit != null;
  });

export const hasUnscalableIngredients = (ingredients: Recipe["ingredients"]): boolean =>
  ingredients.some((ingredient) => !parseIngredientQuantity(ingredient.text).confident);

export const getScaledIngredientText = (text: string, scaling: RecipeScalingState): string => {
  const parsed = parseIngredientQuantity(text);

  if (!parsed.confident) {
    return text;
  }

  return scaleQuantity(getDisplayParsedIngredient(parsed, scaling.unitPreference), scaling.factor);
};

export const RecipeScaleControls: React.FC<RecipeScaleControlsProps> = ({
  className,
  hasAlternateUnits,
  hasUnscalableIngredients: hasUnscalable,
  onScalingChange,
  scaling,
  unitLabels
}) => {
  const scaleOptions = [0.5, 1, 2] as const;
  const setPresetScale = (factor: (typeof scaleOptions)[number]) => {
    onScalingChange((current) => ({
      ...current,
      customFactor: String(factor),
      factor
    }));
  };
  const setCustomScale = (value: string) => {
    const parsedFactor = Number(value);

    onScalingChange((current) => ({
      ...current,
      customFactor: value,
      factor: Number.isFinite(parsedFactor) && parsedFactor > 0 ? parsedFactor : current.factor
    }));
  };

  return (
    <div className={["recipe-scale-controls", className].filter(Boolean).join(" ")}>
      <div aria-label="Recipe scale" className="recipe-scale-segments" role="group">
        {scaleOptions.map((factor) => (
          <button
            aria-pressed={scaling.factor === factor}
            className={`recipe-scale-chip${scaling.factor === factor ? " is-active" : ""}`}
            key={factor}
            onClick={() => setPresetScale(factor)}
            type="button"
          >
            {factor}×
          </button>
        ))}
        <label className="recipe-scale-custom">
          <span>Custom</span>
          <input
            aria-label="Custom recipe scale"
            inputMode="decimal"
            min="0.1"
            onChange={(event) => setCustomScale(event.target.value)}
            step="0.1"
            type="number"
            value={scaling.customFactor}
          />
          <span>x</span>
        </label>
      </div>
      {hasAlternateUnits ? (
        <div aria-label="Ingredient units" className="recipe-scale-segments" role="group">
          <button
            aria-pressed={scaling.unitPreference === "primary"}
            className={`recipe-scale-chip${scaling.unitPreference === "primary" ? " is-active" : ""}`}
            onClick={() =>
              onScalingChange((current) => ({ ...current, unitPreference: "primary" }))
            }
            type="button"
          >
            {unitLabels.primary}
          </button>
          <button
            aria-pressed={scaling.unitPreference === "alternate"}
            className={`recipe-scale-chip${scaling.unitPreference === "alternate" ? " is-active" : ""}`}
            onClick={() =>
              onScalingChange((current) => ({ ...current, unitPreference: "alternate" }))
            }
            type="button"
          >
            {unitLabels.alternate}
          </button>
        </div>
      ) : null}
      {hasUnscalable && scaling.factor !== 1 ? (
        <p className="recipe-scale-note">Some ingredients can’t be scaled automatically.</p>
      ) : null}
    </div>
  );
};

const formatTimerRemaining = (remainingSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.ceil(remainingSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const CookMode: React.FC<CookModeProps> = ({
  onAddIngredientsToShoppingList,
  onFinish,
  onScalingChange,
  recipe,
  scaling: controlledScaling
}) => {
  const [visible, setVisible] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isFinaleVisible, setIsFinaleVisible] = useState(false);
  const [keepAwake, setKeepAwake] = useState(true);
  const [transitionDirection, setTransitionDirection] = useState<1 | -1>(1);
  const [transitionPhase, setTransitionPhase] = useState<"idle" | "exiting" | "entering">("idle");
  const [isIngredientsExpanded, setIsIngredientsExpanded] = useState(false);
  const [cookModeHintsVisible, setCookModeHintsVisible] = useState(false);
  const [checkedIngredientKeys, setCheckedIngredientKeys] = useState<Set<string>>(() => new Set());
  const [internalScaling, setInternalScaling] = useState<RecipeScalingState>(
    DEFAULT_RECIPE_SCALING_STATE
  );
  const [timers, setTimers] = useState<ActiveCookTimer[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [leaveConfirmationVisible, setLeaveConfirmationVisible] = useState(false);
  const stepTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const stepTapGestureRef = useRef<{ hasMoved: boolean; x: number; y: number } | null>(null);
  const suppressStepClickUntilRef = useRef(0);
  const isStepTransitionAnimatingRef = useRef(false);
  const transitionTimeoutsRef = useRef<number[]>([]);
  const titleFlashTimersRef = useRef<number[]>([]);
  const hasReportedFinishRef = useRef(false);
  const cookModeStartedAtRef = useRef<number | null>(null);
  const hasRequestedNotificationPermissionRef = useRef(false);
  const runningTimersRef = useRef(false);
  const onCloseRef = useRef<() => void>(() => undefined);
  const goToPreviousStepRef = useRef<() => void>(() => undefined);
  const goToNextStepRef = useRef<() => void>(() => undefined);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const scaling = controlledScaling ?? internalScaling;
  const setScaling = onScalingChange ?? setInternalScaling;
  const sortedSteps = useMemo(
    () => [...recipe.steps].sort((a, b) => a.index - b.index),
    [recipe.steps]
  );
  const ingredientGroups = useMemo(
    () => groupIngredients(recipe.ingredients),
    [recipe.ingredients]
  );
  const hasAlternateUnits = useMemo(
    () => hasAlternateIngredientUnits(recipe.ingredients),
    [recipe.ingredients]
  );
  const hasUnscalable = useMemo(
    () => hasUnscalableIngredients(recipe.ingredients),
    [recipe.ingredients]
  );
  const unitLabels = useMemo(
    () => getIngredientUnitLabels(recipe.ingredients),
    [recipe.ingredients]
  );
  const currentStep = sortedSteps[currentStepIndex];
  const currentStepDurations = useMemo(
    () => (currentStep ? parseStepDurations(currentStep.text) : []),
    [currentStep]
  );
  const matchedCurrentStepIngredients = useMemo(() => {
    if (!currentStep) {
      return [];
    }

    return matchStepIngredients(currentStep.text, recipe.ingredients)
      .map((ingredientIndex) => recipe.ingredients[ingredientIndex])
      .filter((ingredient): ingredient is Recipe["ingredients"][number] => ingredient != null);
  }, [currentStep, recipe.ingredients]);
  const isFirstStep = !isFinaleVisible && currentStepIndex === 0;
  const isLastStep = currentStepIndex === sortedSteps.length - 1;
  const progressPercent = isFinaleVisible
    ? 100
    : sortedSteps.length > 0
      ? ((currentStepIndex + 1) / sortedSteps.length) * 100
      : 0;

  runningTimersRef.current = timers.some((timer) => timer.endsAt > Date.now());

  const closeCookMode = useCallback(() => {
    setLeaveConfirmationVisible(false);
    setVisible(false);
  }, []);

  const requestClose = useCallback(() => {
    if (runningTimersRef.current) {
      setLeaveConfirmationVisible(true);
      return;
    }

    closeCookMode();
  }, [closeCookMode]);

  const clearTransitionTimers = useCallback(() => {
    transitionTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    transitionTimeoutsRef.current = [];
  }, []);

  const animateToStep = useCallback(
    (nextStepIndex: number, direction: 1 | -1) => {
      if (
        isStepTransitionAnimatingRef.current ||
        isFinaleVisible ||
        nextStepIndex === currentStepIndex ||
        nextStepIndex < 0 ||
        nextStepIndex >= sortedSteps.length
      ) {
        return;
      }

      isStepTransitionAnimatingRef.current = true;
      setTransitionDirection(direction);
      setTransitionPhase("exiting");

      const exitTimeout = window.setTimeout(() => {
        setCurrentStepIndex(nextStepIndex);
        setTransitionPhase("entering");

        const enterTimeout = window.setTimeout(() => {
          setTransitionPhase("idle");
          isStepTransitionAnimatingRef.current = false;
        }, COOK_MODE_STEP_TRANSITION_DURATION_MS);

        transitionTimeoutsRef.current.push(enterTimeout);
      }, COOK_MODE_STEP_TRANSITION_DURATION_MS);

      transitionTimeoutsRef.current.push(exitTimeout);
    },
    [currentStepIndex, isFinaleVisible, sortedSteps.length]
  );

  const animateToFinale = useCallback(() => {
    if (isStepTransitionAnimatingRef.current || isFinaleVisible || !isLastStep) {
      return;
    }

    isStepTransitionAnimatingRef.current = true;
    setTransitionDirection(1);
    setTransitionPhase("exiting");

    const exitTimeout = window.setTimeout(() => {
      if (!hasReportedFinishRef.current) {
        hasReportedFinishRef.current = true;
        const startedAt = cookModeStartedAtRef.current;
        trackWebEvent({
          eventName: "cook_mode_completed",
          routeOrScreen: "recipe",
          properties: {
            ...(startedAt
              ? { elapsed_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)) }
              : {}),
            step_count: sortedSteps.length
          }
        });
        void Promise.resolve(onFinish?.()).catch((error: unknown) => {
          console.warn("Failed to record cook mode completion.", error);
        });
      }

      setIsFinaleVisible(true);
      setTransitionPhase("entering");

      const enterTimeout = window.setTimeout(() => {
        setTransitionPhase("idle");
        isStepTransitionAnimatingRef.current = false;
      }, COOK_MODE_STEP_TRANSITION_DURATION_MS);

      transitionTimeoutsRef.current.push(enterTimeout);
    }, COOK_MODE_STEP_TRANSITION_DURATION_MS);

    transitionTimeoutsRef.current.push(exitTimeout);
  }, [isFinaleVisible, isLastStep, onFinish, sortedSteps.length]);

  const animateFromFinaleToLastStep = useCallback(() => {
    if (isStepTransitionAnimatingRef.current || !isFinaleVisible) {
      return;
    }

    isStepTransitionAnimatingRef.current = true;
    setTransitionDirection(-1);
    setTransitionPhase("exiting");

    const exitTimeout = window.setTimeout(() => {
      setCurrentStepIndex(sortedSteps.length - 1);
      setIsFinaleVisible(false);
      setTransitionPhase("entering");

      const enterTimeout = window.setTimeout(() => {
        setTransitionPhase("idle");
        isStepTransitionAnimatingRef.current = false;
      }, COOK_MODE_STEP_TRANSITION_DURATION_MS);

      transitionTimeoutsRef.current.push(enterTimeout);
    }, COOK_MODE_STEP_TRANSITION_DURATION_MS);

    transitionTimeoutsRef.current.push(exitTimeout);
  }, [isFinaleVisible, sortedSteps.length]);

  const goToPreviousStep = useCallback(() => {
    if (isFinaleVisible) {
      animateFromFinaleToLastStep();
      return;
    }

    animateToStep(currentStepIndex - 1, -1);
  }, [animateFromFinaleToLastStep, animateToStep, currentStepIndex, isFinaleVisible]);

  const goToNextStep = useCallback(() => {
    if (isLastStep) {
      animateToFinale();
      return;
    }

    animateToStep(currentStepIndex + 1, 1);
  }, [animateToFinale, animateToStep, currentStepIndex, isLastStep]);

  useEffect(() => {
    onCloseRef.current = requestClose;
    goToPreviousStepRef.current = goToPreviousStep;
    goToNextStepRef.current = goToNextStep;
  }, [goToNextStep, goToPreviousStep, requestClose]);

  useEffect(() => {
    if (!visible) {
      hasReportedFinishRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    return () => {
      clearTransitionTimers();
    };
  }, [clearTransitionTimers]);

  useEffect(() => {
    if (!visible) {
      clearTransitionTimers();
      isStepTransitionAnimatingRef.current = false;
      setTransitionPhase("idle");
      return;
    }

    setCurrentStepIndex(0);
    setIsFinaleVisible(false);
    setIsIngredientsExpanded(false);
    setCheckedIngredientKeys(new Set());
    setKeepAwake(true);
    setTransitionDirection(1);
    setTransitionPhase("idle");
    setLeaveConfirmationVisible(false);
    isStepTransitionAnimatingRef.current = false;

    try {
      setCookModeHintsVisible(localStorage.getItem(COOK_MODE_HINT_STORAGE_KEY) !== "true");
    } catch {
      setCookModeHintsVisible(false);
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [clearTransitionTimers, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (leaveConfirmationVisible) {
        return;
      }

      if (event.key === "Escape") {
        onCloseRef.current();
      } else if (event.key === "ArrowLeft") {
        goToPreviousStepRef.current();
      } else if (event.key === "ArrowRight") {
        goToNextStepRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [leaveConfirmationVisible, visible]);

  useEffect(() => {
    if (!timers.some((timer) => timer.endsAt > Date.now())) {
      return;
    }

    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(intervalId);
  }, [timers]);

  const requestNotificationPermissionOnce = useCallback(() => {
    if (
      hasRequestedNotificationPermissionRef.current ||
      !("Notification" in window) ||
      Notification.permission !== "default" ||
      !Notification.requestPermission
    ) {
      return;
    }

    hasRequestedNotificationPermissionRef.current = true;
    void Notification.requestPermission().catch(() => undefined);
  }, []);

  const playTimerChime = useCallback(() => {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextConstructor) {
      return;
    }

    try {
      const audioContext = new AudioContextConstructor();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.07, audioContext.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.42);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.44);
      window.setTimeout(() => {
        void audioContext.close().catch(() => undefined);
      }, 500);
    } catch {
      // The title flash and Notification API still carry the completion cue.
    }
  }, []);

  const flashDocumentTitle = useCallback((label: string) => {
    const originalTitle = document.title;
    let flashCount = 0;

    const intervalId = window.setInterval(() => {
      flashCount += 1;
      document.title = flashCount % 2 === 1 ? `Timer done: ${label}` : originalTitle;

      if (flashCount >= DEFAULT_TIMER_TITLE_FLASH_COUNT) {
        window.clearInterval(intervalId);
        document.title = originalTitle;
      }
    }, 700);

    titleFlashTimersRef.current.push(intervalId);
  }, []);

  const announceTimerCompletion = useCallback(
    (timer: ActiveCookTimer) => {
      playTimerChime();
      flashDocumentTitle(timer.label);

      if ("Notification" in window && Notification.permission === "granted") {
        try {
          new Notification("LinkDish timer done", {
            body: `${recipe.title}: ${timer.label}`
          });
        } catch {
          // Notification support can still fail in embedded browsers.
        }
      }
    },
    [flashDocumentTitle, playTimerChime, recipe.title]
  );

  useEffect(() => {
    const completedTimers = timers.filter((timer) => !timer.completed && timer.endsAt <= now);

    if (completedTimers.length === 0) {
      return;
    }

    setTimers((currentTimers) =>
      currentTimers.map((timer) =>
        completedTimers.some((completedTimer) => completedTimer.id === timer.id)
          ? { ...timer, completed: true }
          : timer
      )
    );
    completedTimers.forEach(announceTimerCompletion);
  }, [announceTimerCompletion, now, timers]);

  useEffect(() => {
    return () => {
      titleFlashTimersRef.current.forEach((timerId) => window.clearInterval(timerId));
      titleFlashTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!visible || !keepAwake) {
      void wakeLockRef.current?.release().catch((error) => {
        console.warn("Failed to release cook mode keep awake.", error);
      });
      wakeLockRef.current = null;
      return;
    }

    const wakeLock = navigator.wakeLock;

    if (!wakeLock) {
      return;
    }

    let released = false;

    void wakeLock.request("screen").then(
      (sentinel) => {
        if (released) {
          void sentinel.release();
          return;
        }

        wakeLockRef.current = sentinel;
      },
      (error) => {
        console.warn("Failed to keep the screen awake.", error);
      }
    );

    return () => {
      released = true;
      void wakeLockRef.current?.release().catch((error) => {
        console.warn("Failed to release cook mode keep awake.", error);
      });
      wakeLockRef.current = null;
    };
  }, [keepAwake, visible]);

  const dismissCookModeHints = useCallback(() => {
    try {
      localStorage.setItem(COOK_MODE_HINT_STORAGE_KEY, "true");
    } catch {
      // The overlay should still be dismissible when storage is unavailable.
    }

    setCookModeHintsVisible(false);
  }, []);

  const handleStepTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];

    if (!touch || isStepTransitionAnimatingRef.current) {
      stepTouchStartRef.current = null;
      stepTapGestureRef.current = null;
      return;
    }

    stepTouchStartRef.current = {
      x: touch.pageX,
      y: touch.pageY
    };
    stepTapGestureRef.current = {
      hasMoved: false,
      x: touch.pageX,
      y: touch.pageY
    };
  }, []);

  const handleStepTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = stepTapGestureRef.current;
    const touch = event.changedTouches[0];

    if (!gesture || gesture.hasMoved || !touch) {
      return;
    }

    if (
      Math.abs(touch.pageX - gesture.x) > COOK_MODE_TAP_MOVEMENT_TOLERANCE ||
      Math.abs(touch.pageY - gesture.y) > COOK_MODE_TAP_MOVEMENT_TOLERANCE
    ) {
      gesture.hasMoved = true;
    }
  }, []);

  const handleStepTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const touchStart = stepTouchStartRef.current;
      const tapGesture = stepTapGestureRef.current;
      const touch = event.changedTouches[0];
      stepTouchStartRef.current = null;
      stepTapGestureRef.current = null;

      if (!touchStart || !touch || isStepTransitionAnimatingRef.current) {
        return;
      }

      const deltaX = touch.pageX - touchStart.x;
      const deltaY = touch.pageY - touchStart.y;
      const touchMoved =
        tapGesture?.hasMoved ||
        Math.abs(deltaX) > COOK_MODE_TAP_MOVEMENT_TOLERANCE ||
        Math.abs(deltaY) > COOK_MODE_TAP_MOVEMENT_TOLERANCE;

      if (touchMoved) {
        suppressStepClickUntilRef.current = Date.now() + COOK_MODE_SYNTHETIC_CLICK_GUARD_MS;
      }

      if (!isDeliberateHorizontalCookModeSwipe(deltaX, deltaY, COOK_MODE_SWIPE_THRESHOLD)) {
        return;
      }

      if (deltaX < 0) {
        goToNextStep();
        return;
      }

      goToPreviousStep();
    },
    [goToNextStep, goToPreviousStep]
  );

  const handleStepAreaClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (Date.now() < suppressStepClickUntilRef.current || isStepTransitionAnimatingRef.current) {
        return;
      }

      if (
        event.target instanceof Element &&
        event.target.closest("button, input, label, a, [role='checkbox']")
      ) {
        return;
      }

      const bounds = event.currentTarget.getBoundingClientRect();
      const relativeX = event.clientX - bounds.left;

      if (relativeX <= bounds.width / 3) {
        goToPreviousStep();
      } else if (relativeX >= (bounds.width * 2) / 3) {
        goToNextStep();
      }
    },
    [goToNextStep, goToPreviousStep]
  );

  const toggleIngredient = useCallback((ingredientKey: string) => {
    setCheckedIngredientKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys);

      if (nextKeys.has(ingredientKey)) {
        nextKeys.delete(ingredientKey);
      } else {
        nextKeys.add(ingredientKey);
      }

      return nextKeys;
    });
  }, []);

  const startTimer = useCallback(
    (label: string, maxSeconds: number) => {
      const startedAt = Date.now();

      requestNotificationPermissionOnce();
      setNow(startedAt);
      setTimers((currentTimers) => [
        ...currentTimers,
        {
          completed: false,
          endsAt: startedAt + maxSeconds * 1000,
          id: `${startedAt}-${Math.random().toString(36).slice(2)}`,
          label,
          stepNumber: currentStepIndex + 1
        }
      ]);
    },
    [currentStepIndex, requestNotificationPermissionOnce]
  );

  if (sortedSteps.length === 0) {
    return null;
  }

  const modal = visible ? (
    <div
      aria-label={`Cooking mode for ${recipe.title}`}
      aria-modal="true"
      className="cook-mode-screen"
      role="dialog"
    >
      <div className="cook-mode-header">
        <div className="cook-mode-title-wrap">
          <h1 className="cook-mode-recipe-title">{recipe.title}</h1>
        </div>
        <button
          aria-label="Close cooking mode"
          className="cook-mode-close-button"
          onClick={requestClose}
          type="button"
        >
          <Icon name="close" size={22} />
        </button>
      </div>

      <div className="cook-mode-progress-bar-container">
        <div className="cook-mode-progress-bar-fill" style={{ width: `${progressPercent}%` }} />
      </div>

      <div
        className="cook-mode-step-area"
        onClick={handleStepAreaClick}
        onTouchEnd={handleStepTouchEnd}
        onTouchMove={handleStepTouchMove}
        onTouchStart={handleStepTouchStart}
      >
        <div className="cook-mode-step-scroller">
          <div className="cook-mode-content">
            {isFinaleVisible ? (
              <div
                className={`cook-mode-step-card cook-mode-finale-card is-${transitionPhase}`}
                style={
                  {
                    "--cook-mode-direction": transitionDirection
                  } as React.CSSProperties & { "--cook-mode-direction": number }
                }
              >
                <h2 className="cook-mode-finale-title">{COOK_MODE_FINALE_TITLE}</h2>
                <div className="cook-mode-finale-icon" aria-hidden="true">
                  <Icon name="check" size={30} />
                </div>
                <p className="cook-mode-finale-message">{getCookModeFinaleMessage(recipe.title)}</p>
                <button className="cook-mode-done-button" onClick={requestClose} type="button">
                  {COOK_MODE_DONE_LABEL}
                </button>
                {onAddIngredientsToShoppingList ? (
                  <button
                    className="cook-mode-shopping-button"
                    onClick={() => {
                      void onAddIngredientsToShoppingList();
                    }}
                    type="button"
                  >
                    Add ingredients to shopping list
                  </button>
                ) : null}
              </div>
            ) : currentStep ? (
              <div
                className={`cook-mode-step-card is-${transitionPhase}`}
                style={
                  {
                    "--cook-mode-direction": transitionDirection
                  } as React.CSSProperties & { "--cook-mode-direction": number }
                }
              >
                <div className="cook-mode-step-meta">
                  <span className="cook-mode-step-label">
                    Step {currentStepIndex + 1} of {sortedSteps.length}
                  </span>
                </div>
                <p className="cook-mode-step-text">{currentStep.text}</p>
                {currentStepDurations.length > 0 ? (
                  <div aria-label="Step timers" className="cook-mode-step-timers">
                    {currentStepDurations.map((duration, durationIndex) => (
                      <button
                        className="cook-mode-timer-start-chip"
                        key={`${duration.label}-${durationIndex}`}
                        onClick={() => startTimer(duration.label, duration.maxSeconds)}
                        type="button"
                      >
                        <span className="cook-mode-timer-numerals">{duration.label}</span>
                        <span aria-hidden="true">▸</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {matchedCurrentStepIngredients.length > 0 ? (
                  <div className="cook-mode-step-ingredients">
                    {matchedCurrentStepIngredients.map((ingredient) => (
                      <p className="cook-mode-step-ingredient-line" key={ingredient.text}>
                        {getScaledIngredientText(ingredient.text, scaling)}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="cook-mode-ingredient-reference">
                  <button
                    aria-expanded={isIngredientsExpanded}
                    aria-label="Toggle ingredients visibility"
                    className="cook-mode-ingredients-header"
                    onClick={() => setIsIngredientsExpanded((expanded) => !expanded)}
                    type="button"
                  >
                    <span className="cook-mode-ingredients-label">Ingredients</span>
                    <span
                      className={`cook-mode-ingredients-chevron${
                        isIngredientsExpanded ? " is-expanded" : ""
                      }`}
                    >
                      <Icon name="chevron-down" size={20} />
                    </span>
                  </button>
                  {isIngredientsExpanded ? (
                    <div className="cook-mode-ingredients-content">
                      <RecipeScaleControls
                        className="cook-mode-scale-controls"
                        hasAlternateUnits={hasAlternateUnits}
                        hasUnscalableIngredients={hasUnscalable}
                        onScalingChange={setScaling}
                        scaling={scaling}
                        unitLabels={unitLabels}
                      />
                      {ingredientGroups.map((group) => (
                        <div className="cook-mode-ingredient-group" key={group.key}>
                          {group.section ? (
                            <p className="cook-mode-ingredient-section">{group.section}</p>
                          ) : null}
                          {group.ingredients.map((ingredient) => {
                            const isChecked = checkedIngredientKeys.has(ingredient.key);

                            return (
                              <button
                                aria-checked={isChecked}
                                className={`cook-mode-ingredient-row${
                                  isChecked ? " is-checked" : ""
                                }`}
                                key={ingredient.key}
                                onClick={() => toggleIngredient(ingredient.key)}
                                role="checkbox"
                                type="button"
                              >
                                <span className="cook-mode-ingredient-check">
                                  {isChecked ? <Icon name="check" size={13} /> : null}
                                </span>
                                <span className="cook-mode-ingredient-text">
                                  {getScaledIngredientText(ingredient.text, scaling)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="cook-mode-step-text">No method steps found.</p>
            )}
          </div>
        </div>
      </div>

      {cookModeHintsVisible && (
        <div className="cook-mode-hints" role="status">
          <div className="cook-mode-hint">
            <span aria-hidden="true">← →</span>
            <p>Tap the sides to move through steps.</p>
          </div>
          <div className="cook-mode-hint">
            <Icon name="check" size={18} color="currentColor" />
            <p>Tap ingredients to check them off.</p>
          </div>
          <button className="cook-mode-hints-dismiss" onClick={dismissCookModeHints} type="button">
            Got it
          </button>
        </div>
      )}

      <div className="cook-mode-footer">
        {timers.length > 0 ? (
          <div className="cook-mode-active-timers" aria-label="Active timers">
            {timers.map((timer) => (
              <div
                className={`cook-mode-active-timer-chip${timer.completed ? " is-complete" : ""}`}
                key={timer.id}
              >
                <span className="cook-mode-active-timer-label">
                  Step {timer.stepNumber} · {timer.label}
                </span>
                <span className="cook-mode-active-timer-remaining">
                  {timer.completed ? "Done" : formatTimerRemaining((timer.endsAt - now) / 1000)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="cook-mode-footer-row">
          {!isFirstStep ? (
            <button
              aria-label="Previous step"
              className="cook-mode-arrow-button cook-mode-arrow-button-secondary"
              disabled={transitionPhase !== "idle"}
              onClick={goToPreviousStep}
              type="button"
            >
              <Icon name="arrow-left" size={24} />
            </button>
          ) : (
            <div className="cook-mode-arrow-button-spacer" />
          )}

          <label className="cook-mode-keep-awake-middle-container">
            <Icon
              name="brightness-5"
              size={18}
              color={keepAwake ? "var(--color-accent)" : "var(--color-muted)"}
              className={`cook-mode-keep-awake-icon${keepAwake ? " is-on" : ""}`}
            />
            <span className="cook-mode-keep-awake-middle-text">Keep awake</span>
            <input
              checked={keepAwake}
              className="cook-mode-keep-awake-middle-switch"
              onChange={(event) => setKeepAwake(event.target.checked)}
              type="checkbox"
            />
          </label>

          {isFinaleVisible ? (
            <div className="cook-mode-arrow-button-spacer" />
          ) : (
            <button
              aria-label={isLastStep ? "Finish cooking" : "Next step"}
              className="cook-mode-arrow-button cook-mode-arrow-button-primary"
              disabled={transitionPhase !== "idle"}
              onClick={() => goToNextStep()}
              type="button"
            >
              {isLastStep ? (
                <span className="cook-mode-finish-button-text">Finish</span>
              ) : (
                <Icon name="arrow-right" size={24} />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        className="cook-mode-trigger"
        onClick={() => {
          cookModeStartedAtRef.current = Date.now();
          trackWebEvent({
            eventName: "cook_mode_started",
            routeOrScreen: "recipe",
            properties: {
              entry_point: "recipe_detail",
              step_count: sortedSteps.length
            }
          });
          setVisible(true);
        }}
        type="button"
      >
        <Icon name="chef-hat" size={18} /> Cook mode
      </button>
      {modal ? createPortal(modal, document.body) : null}
      <ConfirmationDialog
        cancelLabel="Keep cooking"
        confirmLabel="Leave"
        message="Your timers will keep counting only while Cook mode stays open."
        onCancel={() => setLeaveConfirmationVisible(false)}
        onConfirm={closeCookMode}
        title="Timers are still running"
        visible={visible && leaveConfirmationVisible}
      />
    </>
  );
};
