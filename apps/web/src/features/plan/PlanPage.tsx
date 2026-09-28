import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { PageHeader } from "../../components/PageHeader";
import { RecipeImage } from "../../components/RecipeImage";
import { useToast } from "../../components/Toast";
import { addDaysToDateKey, isDateKey, toDateKey } from "../../data/date-keys";
import { useSavedRecipes } from "../../data/library-store";
import {
  addMealPlanEntry,
  moveMealPlanEntryOptimistic,
  removeMealPlanEntryOptimistic,
  updateMealPlanEntry,
  useMealPlanRange,
  type MealPlanEntry,
  type MealPlanSlot
} from "../../data/meal-plan-store";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { usePreference } from "../../preferences/preferences-store";
import { useShoppingAccount } from "../shopping/shopping-sync";

import { DayPickerSheet, type DayPickerMode } from "./DayPickerSheet";
import {
  defaultServingsFor,
  findOpenDinnerDates,
  formatWeekRange,
  getDayLabel,
  getWeekDates,
  getWeekTitle,
  PLAN_ENTRY_DRAG_TYPE,
  rankRecipesForPlanning,
  relativeDayName,
  SLOT_LABELS,
  suggestSlot,
  weekStartFor
} from "./plan-utils";
import { PlanEntryCard, type PlanEntryAction } from "./PlanEntryCard";
import { PlanShoppingSheet } from "./PlanShoppingSheet";
import { RecipePickerSheet } from "./RecipePickerSheet";

import type { WebSavedRecipe } from "../library/saved-recipe-types";

import "./PlanPage.css";

type EntrySource = "picker" | "note" | "quick_start" | "duplicate";

const QUICK_START_LIMIT = 8;

/**
 * /plan — the week at a glance. Phones get a vertical list of days, desktop a seven-column board
 * (drag meals between days; the entry menu is the accessible path). Meals come from the cookbook
 * or are quick notes; the whole week goes to the shopping list in one step.
 */
export const PlanPage: React.FC = () => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const weekStartsOn = usePreference("weekStartsOn");
  const isBoard = useMediaQuery(RAIL_MEDIA_QUERY);
  const [searchParams, setSearchParams] = useSearchParams();
  const [todayKey, setTodayKey] = useState(() => toDateKey());
  const currentWeekStart = weekStartFor(todayKey, weekStartsOn);
  const weekParam = searchParams.get("week");
  const weekStart = isDateKey(weekParam) ? weekStartFor(weekParam, weekStartsOn) : currentWeekStart;
  const dates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  const plan = useMealPlanRange(weekStart, 7);
  const library = useSavedRecipes();
  // Keeps the shopping sync layer aware of the account for "Add to shopping list".
  useShoppingAccount();

  const recipesById = useMemo(
    () => new Map(library.recipes.map((recipe) => [recipe.id, recipe])),
    [library.recipes]
  );
  const { accent, title } = getWeekTitle(weekStart, currentWeekStart);
  const weekLabel = formatWeekRange(weekStart);
  const recipeEntryCount = plan.entries.filter((entry) => entry.recipeId).length;

  const [picker, setPicker] = useState<{ date: string; slot: MealPlanSlot } | null>(null);
  const [dayPicker, setDayPicker] = useState<{ entry: MealPlanEntry; mode: DayPickerMode } | null>(
    null
  );
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [dropDate, setDropDate] = useState<string | null>(null);
  /** The week the quick-start panel was offered for (it stays while that week fills up). */
  const [quickStartWeek, setQuickStartWeek] = useState<string | null>(null);

  // The day rolls over while the tab sits open overnight.
  useEffect(() => {
    const refresh = () => setTodayKey(toDateKey());
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    if (plan.status === "ready" && plan.entries.length === 0) {
      setQuickStartWeek(weekStart);
    }
  }, [plan.entries.length, plan.status, weekStart]);

  const goToWeek = (start: string) => {
    setSearchParams(start === currentWeekStart ? {} : { week: start }, { replace: true });
  };

  const showError = useCallback(
    (error: unknown) => {
      showToast({
        id: "plan-error",
        message: getFriendlyErrorMessage(error, "save"),
        tone: "danger"
      });
    },
    [showToast]
  );

  const trackAdded = (
    source: EntrySource | "undo",
    slot: MealPlanSlot,
    kind: "recipe" | "note"
  ) => {
    if (source === "undo") {
      return;
    }

    trackWebEvent({
      eventName: "meal_plan_entry_added",
      properties: { kind, slot, source },
      routeOrScreen: "/plan"
    });
  };

  const addRecipeEntry = async (
    recipe: WebSavedRecipe,
    target: { date: string; slot: MealPlanSlot; servings?: number | undefined },
    source: EntrySource
  ): Promise<MealPlanEntry | null> => {
    try {
      const entry = await addMealPlanEntry({
        date: target.date,
        recipeId: recipe.id,
        servings: target.servings ?? defaultServingsFor(recipe),
        slot: target.slot,
        title: recipe.recipe.title
      });
      trackAdded(source, target.slot, "recipe");
      return entry;
    } catch (error) {
      showError(error);
      return null;
    }
  };

  const undoAdd = (entry: MealPlanEntry) => {
    void removeMealPlanEntryOptimistic(entry.id).catch(showError);
  };

  const restoreEntry = (entry: MealPlanEntry) => {
    void addMealPlanEntry({
      date: entry.date,
      note: entry.note,
      recipeId: entry.recipeId,
      servings: entry.servings,
      slot: entry.slot,
      title: entry.title
    }).catch(showError);
  };

  const handlePickRecipe = async (input: {
    recipe: WebSavedRecipe;
    slot: MealPlanSlot;
    servings?: number | undefined;
  }) => {
    if (!picker) {
      return;
    }

    const date = picker.date;
    setPicker(null);
    const entry = await addRecipeEntry(
      input.recipe,
      { date, servings: input.servings, slot: input.slot },
      "picker"
    );

    if (entry) {
      showToast({
        action: { label: "Undo", onClick: () => undoAdd(entry) },
        icon: "calendar-check",
        id: "plan-added",
        message: `${entry.title} is on for ${relativeDayName(date, todayKey)}`,
        tone: "success"
      });
    }
  };

  const handlePickNote = async (input: { title: string; slot: MealPlanSlot }) => {
    if (!picker) {
      return;
    }

    const date = picker.date;
    setPicker(null);

    try {
      const entry = await addMealPlanEntry({ date, slot: input.slot, title: input.title });
      trackAdded("note", input.slot, "note");
      showToast({
        action: { label: "Undo", onClick: () => undoAdd(entry) },
        icon: "sticky-note",
        id: "plan-added",
        message: `${entry.title} on ${relativeDayName(date, todayKey)}`,
        tone: "success"
      });
    } catch (error) {
      showError(error);
    }
  };

  const handleEntryAction = useCallback(
    (entry: MealPlanEntry, action: PlanEntryAction) => {
      if (action === "open") {
        if (entry.recipeId) {
          void navigate(`/recipes/${entry.recipeId}`);
        }

        return;
      }

      if (action === "move" || action === "duplicate") {
        setDayPicker({ entry, mode: action });
        return;
      }

      void removeMealPlanEntryOptimistic(entry.id).then(
        () => {
          showToast({
            action: { label: "Undo", onClick: () => restoreEntry(entry) },
            icon: "trash",
            id: "plan-removed",
            message: `Removed ${entry.title}`
          });
        },
        (error: unknown) => showError(error)
      );
    },
    // restoreEntry only uses stable helpers.
    [navigate, showError, showToast]
  );

  const handleServingsChange = useCallback(
    (entry: MealPlanEntry, servings: number) => {
      void updateMealPlanEntry(entry.id, { servings }).catch(showError);
    },
    [showError]
  );

  const handleDayPick = async (target: { date: string; slot: MealPlanSlot }) => {
    if (!dayPicker) {
      return;
    }

    const { entry, mode } = dayPicker;
    setDayPicker(null);

    try {
      if (mode === "move") {
        await moveMealPlanEntryOptimistic(entry.id, target);
        showToast({
          action: {
            label: "Undo",
            onClick: () =>
              void moveMealPlanEntryOptimistic(entry.id, {
                date: entry.date,
                slot: entry.slot
              }).catch(showError)
          },
          icon: "calendar-days",
          id: "plan-moved",
          message: `Moved to ${getDayLabel(target.date).weekdayLong} ${SLOT_LABELS[target.slot].toLowerCase()}`
        });
      } else {
        const copy = await addMealPlanEntry({
          date: target.date,
          note: entry.note,
          recipeId: entry.recipeId,
          servings: entry.servings,
          slot: target.slot,
          title: entry.title
        });
        trackAdded("duplicate", target.slot, entry.recipeId ? "recipe" : "note");
        showToast({
          action: { label: "Undo", onClick: () => undoAdd(copy) },
          icon: "copy",
          id: "plan-duplicated",
          message: `Also on ${getDayLabel(target.date).weekdayLong}`
        });
      }

      if (!dates.includes(target.date)) {
        goToWeek(weekStartFor(target.date, weekStartsOn));
      }
    } catch (error) {
      showError(error);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLLIElement>, date: string) => {
    const id = event.dataTransfer.getData(PLAN_ENTRY_DRAG_TYPE);
    setDropDate(null);

    if (!id) {
      return;
    }

    event.preventDefault();
    const entry = plan.entries.find((candidate) => candidate.id === id);

    if (!entry || entry.date === date) {
      return;
    }

    void moveMealPlanEntryOptimistic(id, { date }).then(
      () =>
        showToast({
          action: {
            label: "Undo",
            onClick: () =>
              void moveMealPlanEntryOptimistic(id, { date: entry.date }).catch(showError)
          },
          icon: "calendar-days",
          id: "plan-moved",
          message: `Moved ${entry.title} to ${getDayLabel(date).weekdayLong}`
        }),
      (error: unknown) => showError(error)
    );
  };

  /* ----------------------------- Quick start ----------------------------- */
  const plannedRecipeIds = useMemo(
    () => new Set(plan.entries.flatMap((entry) => (entry.recipeId ? [entry.recipeId] : []))),
    [plan.entries]
  );
  const quickStartRecipes = useMemo(
    () =>
      rankRecipesForPlanning(library.recipes)
        .filter((recipe) => !plannedRecipeIds.has(recipe.id))
        .slice(0, isBoard ? QUICK_START_LIMIT : 6),
    [isBoard, library.recipes, plannedRecipeIds]
  );
  const firstPlannableDay = weekStart === currentWeekStart ? todayKey : weekStart;
  const openDinners = useMemo(
    () => findOpenDinnerDates(dates, plan.entries, firstPlannableDay),
    [dates, firstPlannableDay, plan.entries]
  );
  const showQuickStart =
    quickStartWeek === weekStart &&
    openDinners.length > 0 &&
    library.status === "ready" &&
    weekStart >= currentWeekStart;

  const quickAdd = async (recipe: WebSavedRecipe) => {
    const date = openDinners[0];

    if (!date) {
      return;
    }

    const entry = await addRecipeEntry(recipe, { date, slot: "dinner" }, "quick_start");

    if (entry) {
      showToast({
        action: { label: "Undo", onClick: () => undoAdd(entry) },
        icon: "calendar-check",
        id: "plan-added",
        message: `${entry.title} for ${relativeDayName(date, todayKey)}'s dinner`,
        tone: "success"
      });
    }
  };

  const plannedDinnerCount = plan.entries.filter((entry) => entry.slot === "dinner").length;

  return (
    <div className="plan-page page-enter">
      <PageHeader
        accent={accent}
        eyebrow="Meal plan"
        subtitle={
          <>
            <span className="num">{weekLabel}</span>
            {plan.status === "ready" ? (
              <>
                {" · "}
                {plan.entries.length === 0
                  ? "nothing planned yet"
                  : `${plan.entries.length} ${plan.entries.length === 1 ? "meal" : "meals"} planned`}
              </>
            ) : null}
          </>
        }
        title={title}
      />

      <nav aria-label="Weeks" className="plan-week-nav">
        <IconButton
          aria-label="Previous week"
          icon="chevron-left"
          onClick={() => goToWeek(addDaysToDateKey(weekStart, -7))}
          variant="outline"
        />
        <IconButton
          aria-label="Next week"
          icon="chevron-right"
          onClick={() => goToWeek(addDaysToDateKey(weekStart, 7))}
          variant="outline"
        />
        {weekStart !== currentWeekStart ? (
          <Button
            icon="calendar"
            onClick={() => goToWeek(currentWeekStart)}
            size="sm"
            variant="ghost"
          >
            This week
          </Button>
        ) : null}
        {plan.status === "error" ? (
          <Button icon="refresh" onClick={plan.retry} size="sm" variant="secondary">
            Try again
          </Button>
        ) : null}
        {recipeEntryCount > 0 ? (
          <Button
            className="plan-shop-button"
            icon="shopping-basket"
            onClick={() => setShoppingOpen(true)}
          >
            Add to shopping list
          </Button>
        ) : null}
      </nav>

      {showQuickStart ? (
        <section
          aria-labelledby="plan-quick-start-title"
          className={`plan-quick-start${plannedDinnerCount > 0 ? " has-done" : ""}`}
        >
          <div className="plan-quick-start-copy">
            <p className="plan-quick-start-eyebrow">
              <Icon name="sparkles" size={14} /> Plan dinner in 2 minutes
            </p>
            <h2 className="plan-quick-start-title" id="plan-quick-start-title">
              {plannedDinnerCount === 0 ? "Your week is wide open" : "Nice. Keep going?"}
            </h2>
            <p className="plan-quick-start-body">
              {quickStartRecipes.length > 0
                ? `Tap a recipe and it lands on the next free night${
                    openDinners[0] ? ` (${relativeDayName(openDinners[0], todayKey)})` : ""
                  }.`
                : "Save a few recipes you love and planning becomes a tap."}
            </p>
          </div>
          {quickStartRecipes.length > 0 ? (
            <ul aria-label="Quick add to the next free dinner" className="plan-quick-chips">
              {quickStartRecipes.map((recipe) => (
                <li key={recipe.id}>
                  <button
                    className="plan-quick-chip"
                    onClick={() => void quickAdd(recipe)}
                    type="button"
                  >
                    <RecipeImage
                      aspectRatio="1"
                      className="plan-quick-chip-thumb"
                      image={recipe.recipe.image}
                      sizes="40px"
                      title={recipe.recipe.title}
                      widths={[96]}
                    />
                    <span className="plan-quick-chip-title">{recipe.recipe.title}</span>
                    <Icon className="plan-quick-chip-plus" name="plus" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="plan-quick-actions">
              <ButtonLink icon="plus" to="/import">
                Add a recipe
              </ButtonLink>
              <ButtonLink icon="book-open" to="/" variant="secondary">
                Browse your Cookbook
              </ButtonLink>
            </div>
          )}
          {plannedDinnerCount > 0 ? (
            <Button
              className="plan-quick-done"
              onClick={() => setQuickStartWeek(null)}
              size="sm"
              variant="ghost"
            >
              Done
            </Button>
          ) : null}
        </section>
      ) : null}

      <ol aria-label={`${title} ${accent}`} className="plan-days">
        {dates.map((date) => {
          const day = getDayLabel(date);
          const entries = plan.days.find((bucket) => bucket.date === date)?.entries ?? [];
          const isToday = date === todayKey;
          const isPast = date < todayKey;

          return (
            <li
              className={[
                "plan-day",
                isToday ? "is-today" : "",
                isPast ? "is-past" : "",
                entries.length === 0 ? "is-empty" : "",
                dropDate === date ? "is-drop-target" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              key={date}
              onDragLeave={
                isBoard
                  ? (event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDropDate((current) => (current === date ? null : current));
                      }
                    }
                  : undefined
              }
              onDragOver={
                isBoard
                  ? (event) => {
                      if (event.dataTransfer.types.includes(PLAN_ENTRY_DRAG_TYPE)) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDropDate(date);
                      }
                    }
                  : undefined
              }
              onDrop={isBoard ? (event) => handleDrop(event, date) : undefined}
            >
              <div className="plan-day-header">
                <h2 className="plan-day-heading">
                  <span aria-hidden="true" className="plan-day-name">
                    {day.weekday}
                  </span>
                  <span aria-hidden="true" className="plan-day-date num">
                    {day.dayOfMonth}
                  </span>
                  {isToday ? <span className="plan-day-today">Today</span> : null}
                  <span className="sr-only">{day.long}</span>
                </h2>
                <IconButton
                  aria-label={`Add a meal to ${day.long}`}
                  className="plan-day-add"
                  icon="plus"
                  onClick={() => setPicker({ date, slot: suggestSlot(entries) })}
                  size="sm"
                  variant={isToday ? "filled" : "tonal"}
                />
              </div>
              {entries.length > 0 ? (
                <ul className="plan-day-entries">
                  {entries.map((entry) => {
                    const recipe = entry.recipeId ? recipesById.get(entry.recipeId) : undefined;

                    return (
                      <PlanEntryCard
                        draggable={isBoard}
                        entry={entry}
                        fallbackServings={defaultServingsFor(recipe)}
                        key={entry.id}
                        onAction={handleEntryAction}
                        onServingsChange={handleServingsChange}
                        recipe={recipe}
                      />
                    );
                  })}
                </ul>
              ) : (
                <button
                  className="plan-day-empty"
                  onClick={() => setPicker({ date, slot: "dinner" })}
                  type="button"
                >
                  <Icon className="plan-day-empty-icon" name="plus" size={16} />
                  <span>{isPast ? "Nothing planned" : "Plan a meal"}</span>
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {picker ? (
        <RecipePickerSheet
          date={picker.date}
          initialSlot={picker.slot}
          key={`${picker.date}-${picker.slot}`}
          libraryStatus={library.status}
          onAddNote={(input) => void handlePickNote(input)}
          onAddRecipe={(input) => void handlePickRecipe(input)}
          onClose={() => setPicker(null)}
          open
          recipes={library.recipes}
        />
      ) : null}

      {dayPicker ? (
        <DayPickerSheet
          entry={dayPicker.entry}
          key={`${dayPicker.entry.id}-${dayPicker.mode}`}
          mode={dayPicker.mode}
          onClose={() => setDayPicker(null)}
          onPick={(target) => void handleDayPick(target)}
          open
          todayKey={todayKey}
          weekStart={weekStart}
        />
      ) : null}

      {shoppingOpen ? (
        <PlanShoppingSheet
          entries={plan.entries}
          onClose={() => setShoppingOpen(false)}
          open
          recipesById={recipesById}
          weekLabel={weekLabel}
        />
      ) : null}
    </div>
  );
};
