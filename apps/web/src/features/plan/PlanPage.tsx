import React, { useMemo } from "react";

import { ButtonLink } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { usePreference } from "../../preferences/preferences-store";

import "./PlanPage.css";

interface WeekDay {
  key: string;
  weekday: string;
  dayOfMonth: string;
  isToday: boolean;
}

const buildWeek = (today: Date, weekStartsOn: 0 | 1): WeekDay[] => {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const offset = (start.getDay() - weekStartsOn + 7) % 7;
  start.setDate(start.getDate() - offset);
  const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);

    return {
      key: date.toISOString(),
      weekday: weekdayFormat.format(date),
      dayOfMonth: String(date.getDate()),
      isToday: date.toDateString() === today.toDateString()
    };
  });
};

/**
 * Meal plan destination. The planner itself is built separately; this page shows
 * the week at a glance and points people to their Cookbook in the meantime.
 */
export const PlanPage: React.FC = () => {
  const weekStartsOn = usePreference("weekStartsOn");
  const week = useMemo(() => buildWeek(new Date(), weekStartsOn), [weekStartsOn]);

  return (
    <div className="plan-page container-wide page-enter">
      <PageHeader
        accent="week"
        eyebrow="Meal plan"
        subtitle="Pick dinners from your Cookbook for each day, then shop for all of them at once."
        title="This"
      />

      <ol aria-label="This week" className="plan-week">
        {week.map((day) => (
          <li className={`plan-day${day.isToday ? " is-today" : ""}`} key={day.key}>
            <span className="plan-day-name">{day.weekday}</span>
            <span className="plan-day-date num">{day.dayOfMonth}</span>
            <span className="plan-day-slot">{day.isToday ? "Today" : "Nothing yet"}</span>
          </li>
        ))}
      </ol>

      <div className="plan-empty-card">
        <EmptyState
          actions={
            <>
              <ButtonLink icon="book-open" to="/">
                Browse your Cookbook
              </ButtonLink>
              <ButtonLink icon="shopping-basket" to="/shopping" variant="secondary">
                Shopping list
              </ButtonLink>
            </>
          }
          body="Meal planning is simmering. Soon you'll drop recipes onto days and LinkDish will build one shopping list for the whole week."
          illustration="calendar"
          title="Your week is wide open"
        />
      </div>
    </div>
  );
};
