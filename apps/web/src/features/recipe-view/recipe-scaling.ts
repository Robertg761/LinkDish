import {
  convertTemperaturesInText,
  formatServings,
  getDisplayIngredient,
  getIngredientUnitSummary,
  parseServings,
  scaleFactorForServings
} from "@linkdish/recipe-domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePreference } from "../../preferences/preferences-store";

import type {
  DisplayIngredient,
  IngredientUnitSummary,
  IngredientUnitsPreference,
  ParsedServings,
  Recipe
} from "@linkdish/recipe-domain";

/**
 * Scaling and units for one recipe view (detail page, cook mode, featured pages, shopping).
 * Everything that changes a line of text lives in @linkdish/recipe-domain; this module only
 * holds the view state and memoizes the domain calls.
 */

export type RecipeUnits = IngredientUnitsPreference;

export interface RecipeScalingState {
  /** Multiplier applied to every quantity (1 = as written). */
  factor: number;
  /** What the person typed into the custom factor field (kept separately while typing). */
  customFactor: string;
  /** Show quantities as written, in US units, or in metric. */
  units: RecipeUnits;
}

export const DEFAULT_RECIPE_SCALING_STATE: RecipeScalingState = Object.freeze({
  customFactor: "1",
  factor: 1,
  units: "original"
});

export const MIN_SCALE_FACTOR = 0.1;
export const MAX_SCALE_FACTOR = 20;
export const PRESET_SCALE_FACTORS = [0.5, 1, 2, 3] as const;

type ScalingLike = Pick<RecipeScalingState, "factor"> & { units?: RecipeUnits | undefined };

const clampFactor = (factor: number): number =>
  Math.min(MAX_SCALE_FACTOR, Math.max(MIN_SCALE_FACTOR, factor));

/** Reads a custom factor ("1.5", "1,5", "3/2", "½") or returns null when it is not usable. */
export const parseScaleFactor = (value: string): number | null => {
  const trimmed = value.trim().replace(",", ".").replace(/[x×]$/iu, "").trim();

  if (!trimmed) {
    return null;
  }

  const vulgar: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
  const fraction = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/u);
  const value_ =
    vulgar[trimmed] ??
    (fraction ? Number(fraction[1]) / Number(fraction[2]) : Number.parseFloat(trimmed));

  if (!Number.isFinite(value_) || value_ <= 0 || !/^[\d.¼½¾⅓⅔/\s]+$/u.test(trimmed)) {
    return null;
  }

  return clampFactor(value_);
};

/** "½×", "1×", "1.5×", "2×" */
export const formatScaleFactor = (factor: number): string => {
  const known: Record<string, string> = { "0.25": "¼", "0.5": "½", "0.75": "¾" };
  const rounded = Math.round(factor * 100) / 100;
  return `${known[String(rounded)] ?? String(rounded)}×`;
};

/** One ingredient line as displayed for the given scale and units (legacy-compatible helper). */
export const getScaledIngredientText = (text: string, scaling: ScalingLike): string =>
  getDisplayIngredient(text, { scale: scaling.factor, units: scaling.units ?? "original" }).text;

/** Step text with oven and food temperatures shown in the chosen system. */
export const getDisplayStepText = (text: string, units: RecipeUnits): string =>
  units === "original" ? text : convertTemperaturesInText(text, units);

const QUANTITY_NUMBER = String.raw`[\d¼½¾⅐-⅞⅟](?:[\d¼½¾⅐-⅞⅟.,/⁄]|\s(?=[\d¼½¾⅐-⅞⅟]))*`;
const QUANTITY_UNIT = String.raw`(?:fl\.?\s?oz|oz|ounces?|lbs?|pounds?|kg|kilograms?|g|grams?|mg|ml|mL|millilit(?:er|re)s?|cl|dl|l|L|lit(?:er|re)s?|cups?|Tbsp|tbsp|tablespoons?|tsp|teaspoons?|pints?|pt|quarts?|qt|gallons?|gal|sticks?|cloves?|cans?|tins?|jars?|packages?|pinch(?:es)?|dash(?:es)?|handfuls?|bunch(?:es)?|heads?|sprigs?|stalks?|slices?|pieces?)`;
/** Leading amount (quantity + unit) of a displayed line, so it can be set in bold tabular figures. */
const QUANTITY_PATTERN = new RegExp(
  String.raw`^(?:(?:about|approx\.?|~)\s*)?${QUANTITY_NUMBER}` +
    String.raw`(?:\s*(?:–|—|-|to|or)\s*${QUANTITY_NUMBER})?(?:\s*${QUANTITY_UNIT}\.?(?![\p{L}]))?`,
  "u"
);

export interface IngredientTextParts {
  quantity: string;
  rest: string;
}

/** "3 cups (360 g) flour" → { quantity: "3 cups", rest: " (360 g) flour" }. */
export const splitIngredientQuantity = (text: string): IngredientTextParts => {
  const match = text.match(QUANTITY_PATTERN);

  if (!match?.[0].trim()) {
    return { quantity: "", rest: text };
  }

  return { quantity: match[0], rest: text.slice(match[0].length) };
};

export interface RecipeScalingOptions {
  /** Saved "serves N" for this recipe (per-recipe memory). */
  preferredServings?: number | null | undefined;
  /** Persist a new "serves N" (null = back to the recipe's own count). */
  onPreferredServingsChange?: ((servings: number | null) => void) | undefined;
  /** Start from this factor when there is no servings count (e.g. a resumed cook session). */
  initialFactor?: number | undefined;
}

export interface RecipeScaling {
  state: RecipeScalingState;
  /** Parsed servings, or null when the recipe has no usable count. */
  servings: ParsedServings | null;
  /** The "Serves N" value shown in the stepper (null without a servings count). */
  targetServings: number | null;
  /** "Serves 8", "24 cookies" — the current yield after scaling, or "" when unknown. */
  servingsLabel: string;
  summary: IngredientUnitSummary;
  /** Units actually applied (always "original" when conversion would change nothing). */
  units: RecipeUnits;
  /** True when the quantities differ from the recipe as written. */
  isModified: boolean;
  setFactor: (factor: number) => void;
  setCustomFactor: (value: string) => void;
  setServings: (servings: number) => void;
  setUnits: (units: RecipeUnits) => void;
  reset: () => void;
  /** Memoized display of one ingredient line for the current scale and units. */
  displayIngredient: (text: string) => DisplayIngredient;
  /** Step text with temperatures converted for the current units. */
  displayStep: (text: string) => string;
}

const factorForPreferred = (
  servings: ParsedServings | null,
  preferred: number | null | undefined
) => (servings && preferred && preferred > 0 ? scaleFactorForServings(servings, preferred) : null);

/**
 * View state for scaling a recipe by servings (a "Serves N" stepper when the recipe has a count)
 * or by factor (½× / 1× / 2× / custom), and showing it in original, US or metric units. Units
 * default to the person's preference; servings are remembered per recipe through
 * `onPreferredServingsChange`.
 */
export const useRecipeScaling = (
  recipe: Pick<Recipe, "ingredients" | "servings">,
  options: RecipeScalingOptions = {}
): RecipeScaling => {
  const { preferredServings, onPreferredServingsChange, initialFactor } = options;
  const unitsPreference = usePreference("units");
  const servings = useMemo(() => parseServings(recipe.servings), [recipe.servings]);
  const summary = useMemo(() => getIngredientUnitSummary(recipe.ingredients), [recipe.ingredients]);
  const [factorState, setFactorState] = useState(() => {
    const factor = factorForPreferred(servings, preferredServings) ?? initialFactor ?? 1;
    return { customFactor: String(Math.round(factor * 100) / 100), factor };
  });
  const [unitsOverride, setUnitsOverride] = useState<RecipeUnits | null>(null);
  const onPreferredRef = useRef(onPreferredServingsChange);
  onPreferredRef.current = onPreferredServingsChange;

  // A preference saved elsewhere (another tab, the editor) or a different recipe resets the view.
  const preferredFactor = factorForPreferred(servings, preferredServings);
  useEffect(() => {
    if (preferredFactor != null) {
      setFactorState((current) =>
        Math.abs(current.factor - preferredFactor) < 1e-9
          ? current
          : {
              customFactor: String(Math.round(preferredFactor * 100) / 100),
              factor: preferredFactor
            }
      );
    }
  }, [preferredFactor]);

  const units: RecipeUnits = summary.canConvert ? (unitsOverride ?? unitsPreference) : "original";
  const state = useMemo<RecipeScalingState>(
    () => ({ customFactor: factorState.customFactor, factor: factorState.factor, units }),
    [factorState, units]
  );
  const targetServings = servings
    ? Math.max(1, Math.round(servings.min * factorState.factor * 100) / 100)
    : null;

  const setFactor = useCallback((factor: number) => {
    const next = clampFactor(factor);
    setFactorState({ customFactor: String(Math.round(next * 100) / 100), factor: next });
  }, []);

  const setCustomFactor = useCallback((value: string) => {
    const parsed = parseScaleFactor(value);
    setFactorState((current) => ({ customFactor: value, factor: parsed ?? current.factor }));
  }, []);

  const setServings = useCallback(
    (next: number) => {
      if (!servings || !Number.isFinite(next) || next <= 0) {
        return;
      }

      const factor = scaleFactorForServings(servings, next);
      setFactorState({ customFactor: String(Math.round(factor * 100) / 100), factor });
      onPreferredRef.current?.(next === servings.min ? null : next);
    },
    [servings]
  );

  const setUnits = useCallback((next: RecipeUnits) => setUnitsOverride(next), []);

  const reset = useCallback(() => {
    setFactorState({ customFactor: "1", factor: 1 });
    setUnitsOverride(null);

    if (servings) {
      onPreferredRef.current?.(null);
    }
  }, [servings]);

  const displayCache = useMemo(() => new Map<string, DisplayIngredient>(), [state]);
  const displayIngredient = useCallback(
    (text: string): DisplayIngredient => {
      const cached = displayCache.get(text);

      if (cached) {
        return cached;
      }

      const display = getDisplayIngredient(text, { scale: state.factor, units: state.units });
      displayCache.set(text, display);
      return display;
    },
    [displayCache, state]
  );
  const displayStep = useCallback((text: string) => getDisplayStepText(text, units), [units]);

  return {
    displayIngredient,
    displayStep,
    isModified:
      factorState.factor !== 1 ||
      (summary.canConvert && unitsOverride != null && unitsOverride !== unitsPreference),
    reset,
    servings,
    servingsLabel: servings
      ? formatServings(servings, { scale: factorState.factor })
      : (recipe.servings?.trim() ?? ""),
    setCustomFactor,
    setFactor,
    setServings,
    setUnits,
    state,
    summary,
    targetServings,
    units
  };
};
