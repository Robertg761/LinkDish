import { createStepIngredientMatcher, parseStepDurations } from "@linkdish/recipe-domain";
import React, { memo, useMemo } from "react";

import { Icon } from "../../components/Icon";

import { IngredientLine } from "./IngredientList";
import { formatStepTimerLabel } from "./step-timers";

import type { DisplayIngredient, ParsedStepDuration, Recipe } from "@linkdish/recipe-domain";

import "./MethodList.css";

export const sortRecipeSteps = (steps: Recipe["steps"]): Recipe["steps"] =>
  [...steps].sort((left, right) => left.index - right.index);

/** Builds the step → ingredient matcher once per recipe (it parses every ingredient). */
export const useStepIngredientMatches = (recipe: Pick<Recipe, "ingredients" | "steps">) =>
  useMemo(() => {
    const matcher = createStepIngredientMatcher(recipe.ingredients);
    return sortRecipeSteps(recipe.steps).map((step) => matcher(step.text));
  }, [recipe.ingredients, recipe.steps]);

interface MethodStepProps {
  number: number;
  stepIndex: number;
  text: string;
  durations: ParsedStepDuration[];
  ingredients: Array<{ index: number; text: string }>;
  displayIngredient: (text: string) => DisplayIngredient;
  runningLabels: ReadonlySet<string>;
  onStartTimer?: ((stepIndex: number, duration: ParsedStepDuration) => void) | undefined;
}

const MethodStep = memo<MethodStepProps>(
  ({
    number,
    stepIndex,
    text,
    durations,
    ingredients,
    displayIngredient,
    runningLabels,
    onStartTimer
  }) => (
    <li className="method-step">
      <span aria-hidden="true" className="method-step-number num">
        {number}
      </span>
      <div className="method-step-body">
        <p className="method-step-text">
          <span className="sr-only">Step {number}. </span>
          {text}
        </p>
        {durations.length > 0 && onStartTimer ? (
          <div className="method-step-timers print-hide">
            {durations.map((duration, index) => {
              const label = formatStepTimerLabel(duration);
              const running = runningLabels.has(label);

              return (
                <button
                  aria-label={running ? `${label} timer running` : `Start ${label} timer`}
                  className={`method-timer-chip${running ? " is-running" : ""}`}
                  key={`${label}-${index}`}
                  onClick={() => onStartTimer(stepIndex, duration)}
                  type="button"
                >
                  <Icon name={running ? "hourglass" : "timer"} size={16} strokeWidth={2.2} />
                  <span className="num">{label}</span>
                  {running ? <span className="method-timer-chip-state">Running</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {ingredients.length > 0 ? (
          <div className="method-step-uses">
            <span className="method-step-uses-label">Uses</span>
            <ul aria-label={`Ingredients for step ${number}`}>
              {ingredients.map((ingredient) => (
                <li key={ingredient.index}>
                  <IngredientLine display={displayIngredient(ingredient.text)} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  )
);

MethodStep.displayName = "MethodStep";

interface MethodListProps {
  recipe: Pick<Recipe, "ingredients" | "steps">;
  displayStep: (text: string) => string;
  displayIngredient: (text: string) => DisplayIngredient;
  /** Starts a kitchen timer for a step; omit to hide the timer chips. */
  onStartTimer?: ((stepIndex: number, duration: ParsedStepDuration) => void) | undefined;
  /** Labels of timers already running, keyed by step index. */
  runningTimers?: ReadonlyMap<number, ReadonlySet<string>> | undefined;
  showStepIngredients?: boolean | undefined;
}

const NO_LABELS: ReadonlySet<string> = new Set();
const NO_DURATIONS: ParsedStepDuration[] = [];
const NO_ITEMS: Array<{ index: number; text: string }> = [];

/** Numbered method with inline timer chips and the ingredients each step uses. */
export const MethodList: React.FC<MethodListProps> = ({
  recipe,
  displayStep,
  displayIngredient,
  onStartTimer,
  runningTimers,
  showStepIngredients = true
}) => {
  const steps = useMemo(() => sortRecipeSteps(recipe.steps), [recipe.steps]);
  const durations = useMemo(() => steps.map((step) => parseStepDurations(step.text)), [steps]);
  const matches = useStepIngredientMatches(recipe);
  const stepIngredients = useMemo(
    () =>
      matches.map((indexes) =>
        indexes.flatMap((index) => {
          const ingredient = recipe.ingredients[index];
          return ingredient ? [{ index, text: ingredient.text }] : [];
        })
      ),
    [matches, recipe.ingredients]
  );

  return (
    <ol className="method-list">
      {steps.map((step, stepIndex) => (
        <MethodStep
          displayIngredient={displayIngredient}
          durations={durations[stepIndex] ?? NO_DURATIONS}
          ingredients={showStepIngredients ? (stepIngredients[stepIndex] ?? NO_ITEMS) : NO_ITEMS}
          key={`${step.index}-${stepIndex}`}
          number={stepIndex + 1}
          onStartTimer={onStartTimer}
          runningLabels={runningTimers?.get(stepIndex) ?? NO_LABELS}
          stepIndex={stepIndex}
          text={displayStep(step.text)}
        />
      ))}
    </ol>
  );
};
