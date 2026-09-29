import React from "react";

import { SegmentedControl } from "../../components/SegmentedControl";
import { Sheet } from "../../components/Sheet";
import { Switch } from "../../components/Switch";
import { setPreference, usePreference } from "../../preferences/preferences-store";
import { IngredientList } from "../recipe-view/IngredientList";
import { RecipeScaleBar } from "../recipe-view/RecipeScaleBar";

import { COOK_TEXT_SIZE_OPTIONS } from "./cook-text-size";
import { isSpeechSupported } from "./use-step-speech";

import type { RecipeScaling } from "../recipe-view/recipe-scaling";
import type { IngredientChecks, IngredientGroup } from "../recipe-view/use-ingredient-checks";

interface StepsSheetProps {
  open: boolean;
  onClose: () => void;
  steps: readonly string[];
  currentIndex: number;
  onJump: (index: number) => void;
}

/** Every step at a glance; tap one to jump there. */
export const CookStepsSheet: React.FC<StepsSheetProps> = ({
  open,
  onClose,
  steps,
  currentIndex,
  onJump
}) => (
  <Sheet
    className="cook-steps-sheet"
    description={`Step ${currentIndex + 1} of ${steps.length}`}
    onClose={onClose}
    open={open}
    size="lg"
    title="All steps"
  >
    <ol className="cook-steps-list">
      {steps.map((text, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "next";

        return (
          <li key={`${index}-${text.slice(0, 24)}`}>
            <button
              aria-current={state === "current" ? "step" : undefined}
              className={`cook-steps-item is-${state}`}
              onClick={() => onJump(index)}
              type="button"
            >
              <span aria-hidden="true" className="cook-steps-number num">
                {index + 1}
              </span>
              <span className="cook-steps-text">{text}</span>
            </button>
          </li>
        );
      })}
    </ol>
  </Sheet>
);

interface IngredientsSheetProps {
  open: boolean;
  onClose: () => void;
  groups: readonly IngredientGroup[];
  scaling: RecipeScaling;
  checks: IngredientChecks;
  highlighted: ReadonlySet<string>;
  /** Explains the highlighted lines, e.g. "Used in step 2". */
  highlightLabel?: string | undefined;
}

/** Phones: the full, tickable ingredient list over cook mode. */
export const CookIngredientsSheet: React.FC<IngredientsSheetProps> = ({
  open,
  onClose,
  groups,
  scaling,
  checks,
  highlighted,
  highlightLabel
}) => (
  <Sheet
    className="cook-ingredients-sheet"
    onClose={onClose}
    open={open}
    size="lg"
    title="Ingredients"
  >
    <RecipeScaleBar compact scaling={scaling} />
    <IngredientList
      checked={checks.checked}
      displayIngredient={scaling.displayIngredient}
      groups={groups}
      highlightLabel={highlightLabel}
      highlighted={highlighted}
      onToggle={checks.toggle}
    />
  </Sheet>
);

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  readAloud: boolean;
  onReadAloudChange: (value: boolean) => void;
}

/** Text size, keep-awake and read-aloud. Size and keep-awake are saved as preferences. */
export const CookSettingsSheet: React.FC<SettingsSheetProps> = ({
  open,
  onClose,
  readAloud,
  onReadAloudChange
}) => {
  const textSize = usePreference("cookTextSize");
  const keepScreenAwake = usePreference("keepScreenAwake");
  const wakeLockSupported = typeof navigator !== "undefined" && "wakeLock" in navigator;

  return (
    <Sheet onClose={onClose} open={open} size="sm" title="Cook mode settings">
      <div className="cook-settings-group">
        <span className="cook-settings-label">Step text size</span>
        <SegmentedControl
          aria-label="Step text size"
          fullWidth
          onChange={(value) => setPreference("cookTextSize", value)}
          options={COOK_TEXT_SIZE_OPTIONS}
          value={textSize}
        />
      </div>
      <Switch
        checked={keepScreenAwake}
        description={
          wakeLockSupported
            ? "Your screen stays on while cook mode is open."
            : "This browser can’t keep the screen on. Try Chrome, Edge or Safari 16.4+."
        }
        label="Keep screen awake"
        onChange={(value) => setPreference("keepScreenAwake", value)}
      />
      {isSpeechSupported() ? (
        <Switch
          checked={readAloud}
          description="Hear each step as you move through the recipe."
          label="Read steps aloud"
          onChange={onReadAloudChange}
        />
      ) : null}
    </Sheet>
  );
};
