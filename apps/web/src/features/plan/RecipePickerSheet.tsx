import React, { useMemo, useState } from "react";

import { Button, ButtonLink } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { RecipeImage } from "../../components/RecipeImage";
import { SearchField } from "../../components/SearchField";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { Stepper } from "../../components/Stepper";
import { useRovingRadioGroup } from "../../lib/use-roving-radio";
import { createSavedRecipeSearch } from "../library/components/saved-recipe-search";

import {
  defaultServingsFor,
  describeRecipeForPicker,
  getDayLabel,
  NOTE_PRESETS,
  rankRecipesForPlanning,
  SLOT_OPTIONS
} from "./plan-utils";

import type { MealPlanSlot } from "../../data/meal-plan-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

import "./PlanSheets.css";

interface RecipePickerSheetProps {
  open: boolean;
  onClose: () => void;
  /** Day being planned ("YYYY-MM-DD"). */
  date: string;
  initialSlot: MealPlanSlot;
  recipes: readonly WebSavedRecipe[];
  libraryStatus: "loading" | "ready" | "error";
  onAddRecipe: (input: {
    recipe: WebSavedRecipe;
    slot: MealPlanSlot;
    servings?: number | undefined;
  }) => void;
  onAddNote: (input: { title: string; slot: MealPlanSlot }) => void;
}

const MAX_RESULTS = 80;

/**
 * "What's for Tuesday?": pick a slot, then a recipe from the cookbook (favorites and recently
 * cooked first, searchable) with servings, or jot a quick note like "Leftovers".
 */
export const RecipePickerSheet: React.FC<RecipePickerSheetProps> = ({
  open,
  onClose,
  date,
  initialSlot,
  recipes,
  libraryStatus,
  onAddRecipe,
  onAddNote
}) => {
  const [slot, setSlot] = useState<MealPlanSlot>(initialSlot);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [servings, setServings] = useState<number>(4);
  const [customOpen, setCustomOpen] = useState(false);
  const [customNote, setCustomNote] = useState("");
  const day = getDayLabel(date);

  // What suits the chosen meal comes first (no cookies offered for breakfast).
  const ranked = useMemo(() => rankRecipesForPlanning(recipes, slot), [recipes, slot]);
  // The search index is built on the first typed query and shared across opens.
  const search = useMemo(() => createSavedRecipeSearch(recipes), [recipes]);
  const results = useMemo(
    () =>
      query.trim()
        ? search(query, MAX_RESULTS).map((match) => match.recipe)
        : ranked.slice(0, MAX_RESULTS),
    [query, ranked, search]
  );
  const selected = selectedId ? recipes.find((recipe) => recipe.id === selectedId) : undefined;

  const select = (recipe: WebSavedRecipe) => {
    setSelectedId(recipe.id);
    setServings(defaultServingsFor(recipe) ?? 4);
  };
  const resultIds = useMemo(() => results.map((recipe) => recipe.id), [results]);
  // One Tab stop for the list; arrow keys move through it, so the footer is a Tab away.
  const recipeRadio = useRovingRadioGroup(resultIds, selectedId, (id) => {
    const recipe = results.find((entry) => entry.id === id);

    if (recipe) {
      select(recipe);
    }
  });

  const addSelected = () => {
    if (selected) {
      onAddRecipe({ recipe: selected, servings, slot });
    }
  };

  const addCustomNote = () => {
    const title = customNote.trim();

    if (title) {
      onAddNote({ slot, title });
    }
  };

  const isEmptyLibrary = libraryStatus === "ready" && recipes.length === 0;

  return (
    <Sheet
      className="plan-picker-sheet"
      description={day.long}
      footer={
        <div className="plan-picker-footer">
          {selected ? (
            <div className="plan-picker-servings">
              <Icon name="users" size={18} />
              <Stepper
                label="Servings"
                max={99}
                min={1}
                onChange={setServings}
                size="sm"
                value={servings}
              />
            </div>
          ) : (
            <span className="plan-picker-hint">Pick a recipe or a note</span>
          )}
          <Button
            className="plan-picker-add"
            disabled={!selected}
            icon="calendar-plus"
            onClick={addSelected}
          >
            Add to {day.weekday}
          </Button>
        </div>
      }
      onClose={onClose}
      open={open}
      size="lg"
      testId="plan-recipe-picker"
      title={`Plan ${SLOT_OPTIONS.find((option) => option.value === slot)?.label.toLowerCase() ?? "a meal"}`}
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

      <div className="plan-picker-notes">
        <span className="plan-picker-notes-label">Quick note</span>
        <ul className="plan-picker-note-chips">
          {NOTE_PRESETS.map((preset) => (
            <li key={preset.title}>
              <button
                className="plan-note-chip"
                onClick={() => onAddNote({ slot, title: preset.title })}
                type="button"
              >
                <Icon name={preset.icon} size={16} />
                {preset.title}
              </button>
            </li>
          ))}
          <li>
            <button
              aria-expanded={customOpen}
              className="plan-note-chip is-quiet"
              onClick={() => setCustomOpen((current) => !current)}
              type="button"
            >
              <Icon name="pencil" size={16} />
              Your own
            </button>
          </li>
        </ul>
        {customOpen ? (
          <form
            className="plan-picker-custom"
            onSubmit={(event) => {
              event.preventDefault();
              addCustomNote();
            }}
          >
            <input
              aria-label="Note"
              autoFocus
              className="plan-picker-custom-input"
              maxLength={200}
              onChange={(event) => setCustomNote(event.target.value)}
              placeholder="Pizza night, Grandma's, fend for yourself…"
              value={customNote}
            />
            <Button disabled={!customNote.trim()} size="sm" type="submit" variant="tonal">
              Add note
            </Button>
          </form>
        ) : null}
      </div>

      {isEmptyLibrary ? (
        <EmptyState
          actions={
            <ButtonLink icon="plus" to="/import" variant="primary">
              Add a recipe
            </ButtonLink>
          }
          body="Save a recipe or two and they'll show up here, ready to plan."
          compact
          headingLevel={3}
          illustration="cookbook"
          title="Your cookbook is empty"
        />
      ) : (
        <>
          <SearchField
            aria-label="Search your cookbook"
            onValueChange={setQuery}
            placeholder="Search your cookbook"
            value={query}
          />
          {libraryStatus === "loading" && recipes.length === 0 ? (
            <div className="plan-picker-loading">
              {[0, 1, 2].map((key) => (
                <Skeleton height={64} key={key} radius={16} shape="rect" width="100%" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <p className="plan-picker-none">Nothing matches “{query.trim()}”.</p>
          ) : (
            <ul aria-label="Recipes" className="plan-picker-list" role="radiogroup">
              {results.map((recipe, index) => {
                const isSelected = recipe.id === selectedId;
                const meta = describeRecipeForPicker(recipe);

                return (
                  <li key={recipe.id}>
                    <button
                      aria-checked={isSelected}
                      className={`plan-picker-row${isSelected ? " is-selected" : ""}`}
                      onClick={() => select(recipe)}
                      onDoubleClick={() =>
                        onAddRecipe({ recipe, servings: defaultServingsFor(recipe), slot })
                      }
                      role="radio"
                      type="button"
                      {...recipeRadio(index)}
                    >
                      <RecipeImage
                        aspectRatio="1"
                        className="plan-picker-thumb"
                        image={recipe.recipe.image}
                        sizes="56px"
                        title={recipe.recipe.title}
                        widths={[96]}
                      />
                      <span className="plan-picker-copy">
                        <span className="plan-picker-title">{recipe.recipe.title}</span>
                        {meta || recipe.favorite ? (
                          <span className="plan-picker-meta">
                            {/* A quiet heart, not the word "Favorite" on every row. */}
                            {recipe.favorite ? (
                              <span className="plan-picker-favorite" title="Favorite">
                                <Icon name="heart-filled" size={12} />
                                <span className="sr-only">Favorite</span>
                              </span>
                            ) : null}
                            {meta ? <span>{meta}</span> : null}
                          </span>
                        ) : null}
                      </span>
                      <span aria-hidden="true" className="plan-picker-radio">
                        <Icon name="check" size={14} strokeWidth={3} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Sheet>
  );
};
