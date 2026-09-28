import React, { useId } from "react";

import { SegmentedControl } from "../../components/SegmentedControl";
import { Stepper } from "../../components/Stepper";

import { formatScaleFactor, PRESET_SCALE_FACTORS } from "./recipe-scaling";

import type { RecipeScaling, RecipeUnits } from "./recipe-scaling";

import "./RecipeScaleBar.css";

const UNIT_OPTIONS: ReadonlyArray<{ value: RecipeUnits; label: string }> = [
  { label: "Original", value: "original" },
  { label: "US", value: "us" },
  { label: "Metric", value: "metric" }
];

const MAX_SERVINGS = 200;

interface RecipeScaleBarProps {
  scaling: RecipeScaling;
  /** Whether any displayed line was converted through the density table. */
  hasApproximateLines?: boolean | undefined;
  className?: string | undefined;
  compact?: boolean | undefined;
}

/** Stepper text for a yield: "Serves 6", "10 slices", "Makes 12". */
const formatYieldValue = (
  servings: NonNullable<RecipeScaling["servings"]>,
  value: number
): string => {
  if (servings.kind === "servings") {
    return `Serves ${value}`;
  }

  return servings.noun ? `${value} ${servings.noun}` : `Makes ${value}`;
};

/**
 * Servings and units for a recipe: one −/+ stepper whenever the yield has a count ("Serves 6",
 * "10 slices", "2 bowls"), batch chips (½× 1× 2× 3× + other) only for a yield without one, and
 * Original / US / Metric when converting would change something.
 */
export const RecipeScaleBar: React.FC<RecipeScaleBarProps> = ({
  scaling,
  hasApproximateLines = false,
  className = "",
  compact = false
}) => {
  const customId = useId();
  const { servings, state, summary } = scaling;
  const byServings = servings != null && scaling.targetServings != null;
  const isPreset = PRESET_SCALE_FACTORS.some((factor) => Math.abs(factor - state.factor) < 1e-9);
  const factorOptions = PRESET_SCALE_FACTORS.map((factor) => ({
    label: formatScaleFactor(factor),
    value: String(factor)
  }));
  const notes: Array<{ id: string; content: React.ReactNode }> = [];

  if (!byServings && servings && state.factor !== 1 && scaling.servingsLabel) {
    notes.push({
      content: `Makes ${scaling.servingsLabel.replace(/^Makes\s+/u, "")}`,
      id: "yield"
    });
  }

  if (summary.hasUnscalableLines && state.factor !== 1) {
    notes.push({ content: "Some ingredients can’t be scaled automatically.", id: "unscalable" });
  }

  if (hasApproximateLines) {
    notes.push({
      content: (
        <>
          <span aria-hidden="true" className="recipe-approx-mark">
            ≈
          </span>{" "}
          Converted by weight, so it’s close but not exact.
        </>
      ),
      id: "approximate"
    });
  }

  return (
    <div
      className={["recipe-scale-bar", compact ? "is-compact" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="recipe-scale-bar-row">
        {byServings ? (
          <Stepper
            className="recipe-scale-bar-stepper"
            formatValue={(value) => formatYieldValue(servings, value)}
            label={servings.kind === "servings" ? "Servings" : "Amount"}
            max={MAX_SERVINGS}
            min={1}
            onChange={scaling.setServings}
            value={Math.max(1, Math.round(scaling.targetServings ?? 1))}
          />
        ) : (
          <div className="recipe-scale-bar-factor">
            <SegmentedControl
              aria-label="Recipe scale"
              onChange={(value) => scaling.setFactor(Number(value))}
              options={factorOptions}
              size="sm"
              value={isPreset ? String(state.factor) : ""}
            />
            {/* Reads as a field, not a removable chip: the × (times) appears only with a number. */}
            <label
              className={`recipe-scale-bar-custom${isPreset ? "" : " is-active"}`}
              htmlFor={customId}
            >
              <span className="sr-only">Custom recipe scale</span>
              <input
                aria-label="Custom recipe scale"
                className={`num${isPreset ? "" : " is-active"}`}
                id={customId}
                inputMode="decimal"
                onChange={(event) => scaling.setCustomFactor(event.target.value)}
                placeholder="Other"
                type="text"
                value={isPreset ? "" : state.customFactor}
              />
              {isPreset ? null : (
                <span aria-hidden="true" className="recipe-scale-bar-custom-unit">
                  ×
                </span>
              )}
            </label>
          </div>
        )}

        {summary.canConvert ? (
          <SegmentedControl
            aria-label="Ingredient units"
            className="recipe-scale-bar-units"
            onChange={scaling.setUnits}
            options={UNIT_OPTIONS}
            size="sm"
            value={scaling.units}
          />
        ) : null}
      </div>

      {notes.length > 0 || scaling.isModified ? (
        <p className="recipe-scale-bar-note">
          {notes.map((note) => (
            <span className="recipe-scale-bar-note-item" key={note.id}>
              {note.content}
            </span>
          ))}
          {scaling.isModified ? (
            <button className="recipe-scale-bar-reset" onClick={scaling.reset} type="button">
              Reset
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
};
