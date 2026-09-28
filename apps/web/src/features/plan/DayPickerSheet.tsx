import React, { useState } from "react";

import { SegmentedControl } from "../../components/SegmentedControl";
import { Sheet } from "../../components/Sheet";
import { addDaysToDateKey, getDateKeyRange } from "../../data/date-keys";

import { formatWeekRange, getDayLabel, SLOT_OPTIONS } from "./plan-utils";

import type { MealPlanEntry, MealPlanSlot } from "../../data/meal-plan-store";

import "./PlanSheets.css";

export type DayPickerMode = "move" | "duplicate";

interface DayPickerSheetProps {
  open: boolean;
  onClose: () => void;
  entry: MealPlanEntry;
  mode: DayPickerMode;
  /** First day shown (the planner's week start). Two weeks are offered. */
  weekStart: string;
  todayKey: string;
  onPick: (target: { date: string; slot: MealPlanSlot }) => void;
}

/** "Move to…" / "Duplicate to…": one tap on a day (this week or next) does it. */
export const DayPickerSheet: React.FC<DayPickerSheetProps> = ({
  open,
  onClose,
  entry,
  mode,
  weekStart,
  todayKey,
  onPick
}) => {
  const [slot, setSlot] = useState<MealPlanSlot>(entry.slot);
  const weeks = [getDateKeyRange(weekStart, 7), getDateKeyRange(addDaysToDateKey(weekStart, 7), 7)];

  return (
    <Sheet
      description={entry.title}
      onClose={onClose}
      open={open}
      size="md"
      title={mode === "move" ? "Move to…" : "Duplicate to…"}
    >
      <SegmentedControl
        aria-label="Meal"
        className="plan-slot-control"
        fullWidth
        onChange={setSlot}
        options={SLOT_OPTIONS}
        size="sm"
        value={slot}
      />
      {weeks.map((dates) => (
        <section className="plan-daypicker-week" key={dates[0]}>
          <h3 className="plan-daypicker-heading">{formatWeekRange(dates[0] ?? weekStart)}</h3>
          <ul className="plan-daypicker-grid">
            {dates.map((date) => {
              const label = getDayLabel(date);
              const isCurrent = date === entry.date && slot === entry.slot && mode === "move";

              return (
                <li key={date}>
                  <button
                    aria-label={`${label.long}${date === todayKey ? " (today)" : ""}`}
                    className={[
                      "plan-daypicker-day",
                      date === todayKey ? "is-today" : "",
                      date === entry.date ? "is-origin" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    disabled={isCurrent}
                    onClick={() => onPick({ date, slot })}
                    type="button"
                  >
                    <span className="plan-daypicker-weekday">{label.weekday}</span>
                    <span className="plan-daypicker-date num">{label.dayOfMonth}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Sheet>
  );
};
