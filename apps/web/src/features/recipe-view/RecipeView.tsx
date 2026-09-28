import React, { useCallback, useId, useMemo } from "react";

import { Icon } from "../../components/Icon";
import { startKitchenTimer, useKitchenTimers } from "../cook-mode/timer-store";

import { IngredientList } from "./IngredientList";
import { MethodList, sortRecipeSteps } from "./MethodList";
import { NotesCard } from "./NotesCard";
import { NutritionCard } from "./NutritionCard";
import { RecipeHero } from "./RecipeHero";
import { RecipeScaleBar } from "./RecipeScaleBar";
import { SourceScans } from "./SourceScans";
import { formatStepTimerLabel, getStepTimerSeconds } from "./step-timers";
import { groupRecipeIngredients } from "./use-ingredient-checks";

import type { RecipeScaling } from "./recipe-scaling";
import type { RecipeSourceInfo } from "./recipe-source";
import type { IngredientChecks } from "./use-ingredient-checks";
import type { RecipeRating } from "../library/saved-recipe-types";
import type { ExtractRecipeImage } from "@linkdish/api-contracts";
import type { ParsedStepDuration, Recipe } from "@linkdish/recipe-domain";

import "./RecipeView.css";

export interface RecipeTimerContext {
  /** Cook-session key the timers belong to (saved recipe id, "featured:<slug>", …). */
  sessionKey: string;
  recipeTitle: string;
  href?: string | undefined;
}

export interface RecipeViewProps {
  recipe: Recipe;
  source: RecipeSourceInfo;
  scaling: RecipeScaling;
  /** Tick-off state; null renders a read-only ingredient list. */
  checks: IngredientChecks | null;
  /** Enables step timer chips. */
  timerContext?: RecipeTimerContext | null | undefined;
  heroActions?: React.ReactNode;
  heroEyebrow?: React.ReactNode;
  /** Shown between the hero and the ingredients (banners, status). */
  banner?: React.ReactNode;
  /** Extra content at the end of the main column. */
  footer?: React.ReactNode;
  tags?: readonly string[] | undefined;
  rating?: RecipeRating | null | undefined;
  onRate?: ((rating: RecipeRating | null) => void) | undefined;
  timesCooked?: number | undefined;
  lastCookedAt?: string | undefined;
  notes?: string | null | undefined;
  onSaveNotes?: ((notes: string | null) => Promise<void>) | undefined;
  sourceImages?: readonly ExtractRecipeImage[] | undefined;
  warnings?: readonly string[] | undefined;
}

/**
 * The shared recipe layout used by the recipe page and the featured landing pages: hero, then
 * ingredients (with servings/units and tick-off) and the method. From 1024px the ingredients sit
 * in a sticky column beside the method; print gets a clean two-column sheet.
 */
export const RecipeView: React.FC<RecipeViewProps> = ({
  recipe,
  source,
  scaling,
  checks,
  timerContext,
  heroActions,
  heroEyebrow,
  banner,
  footer,
  tags,
  rating,
  onRate,
  timesCooked,
  lastCookedAt,
  notes,
  onSaveNotes,
  sourceImages,
  warnings
}) => {
  const titleId = useId();
  const ingredientsHeadingId = useId();
  const methodHeadingId = useId();
  const groups = useMemo(() => groupRecipeIngredients(recipe.ingredients), [recipe.ingredients]);
  const { displayIngredient, displayStep } = scaling;
  const hasApproximateLines = useMemo(
    () => recipe.ingredients.some((ingredient) => displayIngredient(ingredient.text).approximate),
    [displayIngredient, recipe.ingredients]
  );
  const stepCount = useMemo(() => sortRecipeSteps(recipe.steps).length, [recipe.steps]);
  const timers = useKitchenTimers();
  const sessionKey = timerContext?.sessionKey;
  const runningTimers = useMemo(() => {
    const map = new Map<number, Set<string>>();

    for (const timer of timers) {
      if (timer.recipeId !== sessionKey || timer.doneAt != null || timer.stepIndex == null) {
        continue;
      }

      const labels = map.get(timer.stepIndex) ?? new Set<string>();
      labels.add(timer.label);
      map.set(timer.stepIndex, labels);
    }

    return map;
  }, [sessionKey, timers]);

  const handleStartTimer = useCallback(
    (stepIndex: number, duration: ParsedStepDuration) => {
      const label = formatStepTimerLabel(duration);

      if (!timerContext || runningTimers.get(stepIndex)?.has(label)) {
        return;
      }

      startKitchenTimer({
        durationMs: getStepTimerSeconds(duration) * 1000,
        href: timerContext.href,
        label,
        recipeId: timerContext.sessionKey,
        recipeTitle: timerContext.recipeTitle,
        stepIndex
      });
    },
    [runningTimers, timerContext]
  );

  const checkedCount = checks
    ? groups.reduce(
        (count, group) => count + group.items.filter((item) => checks.checked.has(item.key)).length,
        0
      )
    : 0;

  return (
    <article aria-labelledby={titleId} className="recipe-view print-target">
      <RecipeHero
        actions={heroActions}
        eyebrow={heroEyebrow}
        lastCookedAt={lastCookedAt}
        onRate={onRate}
        rating={rating}
        recipe={recipe}
        servingsLabel={scaling.servingsLabel}
        source={source}
        tags={tags}
        timesCooked={timesCooked}
        titleId={titleId}
      />

      {banner}

      <div className="recipe-view-body">
        <section aria-labelledby={ingredientsHeadingId} className="recipe-view-ingredients">
          <div className="recipe-panel recipe-view-ingredients-card">
            <div className="recipe-section-header">
              <h2 className="recipe-section-title" id={ingredientsHeadingId}>
                Ingredients
              </h2>
              {checks && checkedCount > 0 ? (
                <button
                  className="recipe-section-link print-hide"
                  onClick={checks.clear}
                  type="button"
                >
                  <span className="num">
                    {checkedCount}/{recipe.ingredients.length}
                  </span>{" "}
                  · Clear
                </button>
              ) : (
                <span className="recipe-section-count num">{recipe.ingredients.length} items</span>
              )}
            </div>
            <RecipeScaleBar hasApproximateLines={hasApproximateLines} scaling={scaling} />
            <IngredientList
              checked={checks?.checked}
              displayIngredient={displayIngredient}
              groups={groups}
              onToggle={checks?.toggle}
            />
          </div>
        </section>

        <div className="recipe-view-main">
          <section aria-labelledby={methodHeadingId} className="recipe-view-method">
            <div className="recipe-section-header">
              <h2 className="recipe-section-title" id={methodHeadingId}>
                Method
              </h2>
              <span className="recipe-section-count num">
                {stepCount} step{stepCount === 1 ? "" : "s"}
              </span>
            </div>
            <MethodList
              displayIngredient={displayIngredient}
              displayStep={displayStep}
              onStartTimer={timerContext ? handleStartTimer : undefined}
              recipe={recipe}
              runningTimers={runningTimers}
            />
          </section>

          <NotesCard notes={notes} onSave={onSaveNotes} />
          <NutritionCard nutrition={recipe.nutrition} />
          <SourceScans images={sourceImages} />

          {warnings && warnings.length > 0 ? (
            <section className="recipe-panel recipe-view-warnings print-hide">
              <h2 className="recipe-section-title">
                <Icon name="info" size={18} /> Worth a double-check
              </h2>
              <ul>
                {warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {footer}

          {source.shareUrl ? (
            <p className="screen-hidden-print-visible recipe-view-print-source">
              Source: {source.shareUrl} · Saved with LinkDish
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
};
