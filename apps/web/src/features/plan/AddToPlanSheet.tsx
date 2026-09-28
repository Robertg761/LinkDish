import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Sheet } from "../../components/Sheet";
import { Stepper } from "../../components/Stepper";
import { useToast } from "../../components/Toast";
import { getDateKeyRange, toDateKey } from "../../data/date-keys";
import { useSavedRecipe } from "../../data/library-store";
import {
  addMealPlanEntry,
  useMealPlanRange,
  type MealPlanEntry,
  type MealPlanSlot
} from "../../data/meal-plan-store";
import { useRovingRadioGroup } from "../../lib/use-roving-radio";
import { usePreference } from "../../preferences/preferences-store";

import {
  defaultServingsFor,
  getDayLabel,
  relativeDayName,
  SLOT_LABELS,
  SLOT_OPTIONS,
  weekStartFor
} from "./plan-utils";

import "./PlanSheets.css";

export interface AddToPlanSheetProps {
  open: boolean;
  onClose: () => void;
  recipeId: string;
  recipeTitle: string;
  /** Servings to plan for; defaults to the cook's preferred servings or the recipe's yield. */
  defaultServings?: number | undefined;
  /** Called after the entry is saved. */
  onAdded?: ((entry: MealPlanEntry) => void) | undefined;
  /** Where the sheet was opened, for the meal_plan_entry_added event. */
  analyticsSource?: "recipe_page" | "cookbook" | undefined;
}

const DAYS_AHEAD = 14;

/**
 * "Add to plan" from a recipe: pick one of the next 14 days, a meal and servings. Days that
 * already have something planned show a dot.
 */
export const AddToPlanSheet: React.FC<AddToPlanSheetProps> = ({
  open,
  onClose,
  recipeId,
  recipeTitle,
  defaultServings,
  onAdded,
  analyticsSource = "recipe_page"
}) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const weekStartsOn = usePreference("weekStartsOn");
  const { recipe } = useSavedRecipe(recipeId);
  const [todayKey] = useState(() => toDateKey());
  const dates = useMemo(() => getDateKeyRange(todayKey, DAYS_AHEAD), [todayKey]);
  const plan = useMealPlanRange(todayKey, DAYS_AHEAD);
  const [date, setDate] = useState(todayKey);
  const [slot, setSlot] = useState<MealPlanSlot>("dinner");
  const [servingsOverride, setServingsOverride] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const servings = servingsOverride ?? defaultServings ?? defaultServingsFor(recipe) ?? 4;
  const plannedDates = useMemo(
    () => new Set(plan.entries.map((entry) => entry.date)),
    [plan.entries]
  );
  const slotTaken = plan.entries.some((entry) => entry.date === date && entry.slot === slot);
  const dayRadio = useRovingRadioGroup(dates, date, setDate);

  const save = async () => {
    setSaving(true);
    setError("");

    try {
      const entry = await addMealPlanEntry({
        date,
        recipeId,
        servings,
        slot,
        title: recipe?.recipe.title ?? recipeTitle
      });
      trackWebEvent({
        eventName: "meal_plan_entry_added",
        properties: { kind: "recipe", slot, source: analyticsSource },
        routeOrScreen: window.location.pathname
      });
      showToast({
        action: {
          label: "View plan",
          onClick: () => {
            void navigate(`/plan?week=${weekStartFor(date, weekStartsOn)}`);
          }
        },
        icon: "calendar-check",
        id: "plan-added",
        message: `Planned for ${relativeDayName(date, todayKey)}'s ${SLOT_LABELS[slot].toLowerCase()}`,
        tone: "success"
      });
      onAdded?.(entry);
      onClose();
    } catch (saveError) {
      setError(getFriendlyErrorMessage(saveError, "save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      description={recipe?.recipe.title ?? recipeTitle}
      dismissible={!saving}
      footer={
        <>
          <Button disabled={saving} onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button icon="calendar-plus" loading={saving} onClick={() => void save()}>
            Add to plan
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      testId="add-to-plan-sheet"
      title="Add to your plan"
    >
      {error ? (
        <p className="plan-sheet-error" role="alert">
          <Icon name="alert-circle" size={18} /> {error}
        </p>
      ) : null}

      <div className="plan-add-field">
        <span className="plan-add-label" id="plan-add-day-label">
          Day
        </span>
        <ul aria-labelledby="plan-add-day-label" className="plan-add-days" role="radiogroup">
          {dates.map((key, index) => {
            const label = getDayLabel(key);
            const selected = key === date;

            return (
              <li key={key}>
                <button
                  aria-checked={selected}
                  aria-label={`${label.long}${key === todayKey ? " (today)" : ""}${
                    plannedDates.has(key) ? ", has meals planned" : ""
                  }`}
                  className={[
                    "plan-add-day",
                    selected ? "is-selected" : "",
                    key === todayKey ? "is-today" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => setDate(key)}
                  role="radio"
                  type="button"
                  {...dayRadio(index)}
                >
                  {/* Today keeps its weekday (a wider "TODAY" overflowed the tile); the accent
                      colour and ring mark it. */}
                  <span className="plan-add-day-name">{label.weekday}</span>
                  <span className="plan-add-day-date num">{label.dayOfMonth}</span>
                  <span
                    aria-hidden="true"
                    className={`plan-add-day-dot${plannedDates.has(key) ? " is-visible" : ""}`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="plan-add-field">
        <span className="plan-add-label">Meal</span>
        <SegmentedControl
          aria-label="Meal"
          className="plan-slot-control"
          fullWidth
          onChange={setSlot}
          options={SLOT_OPTIONS}
          size="sm"
          value={slot}
        />
        {slotTaken ? (
          <p className="plan-add-hint">
            {getDayLabel(date).weekdayLong} already has a {SLOT_LABELS[slot].toLowerCase()}. This
            adds another.
          </p>
        ) : null}
      </div>

      <div className="plan-add-field is-row">
        <span className="plan-add-label">Servings</span>
        <Stepper
          label="Servings"
          max={99}
          min={1}
          onChange={setServingsOverride}
          value={servings}
        />
      </div>
    </Sheet>
  );
};
