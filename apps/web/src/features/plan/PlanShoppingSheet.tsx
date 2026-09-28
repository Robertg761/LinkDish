import {
  buildShoppingInputsForPlan,
  canonicalIngredientKey,
  formatShoppingItemText,
  isPantryStaple,
  mergeShoppingInputs,
  SHOPPING_CATEGORIES
} from "@linkdish/recipe-domain";
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { usePreference } from "../../preferences/preferences-store";
import {
  addParsedShoppingItems,
  roundUpCountForShopping,
  useShoppingList
} from "../shopping/shopping-list-store";
import { getShoppingWriteOptions, requestShoppingSync } from "../shopping/shopping-sync";
import { ShoppingChecklist } from "../shopping/ShoppingChecklist";

import type { MealPlanEntry } from "../../data/meal-plan-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { ShoppingChecklistGroup } from "../shopping/ShoppingChecklist";
import type { AggregatedShoppingItem, Recipe } from "@linkdish/recipe-domain";

import "./PlanSheets.css";

interface PlanShoppingSheetProps {
  open: boolean;
  onClose: () => void;
  entries: readonly MealPlanEntry[];
  recipesById: ReadonlyMap<string, WebSavedRecipe>;
  /** "Sep 28 – Oct 4" */
  weekLabel: string;
}

/** Every planned recipe's ingredients for the week, merged and sorted by aisle, then added. */
export const PlanShoppingSheet: React.FC<PlanShoppingSheetProps> = ({
  open,
  onClose,
  entries,
  recipesById,
  weekLabel
}) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const units = usePreference("units");
  const { items: listItems } = useShoppingList();

  const planned = useMemo(() => {
    const recipes = new Map<string, Recipe>();

    for (const entry of entries) {
      const saved = entry.recipeId ? recipesById.get(entry.recipeId) : undefined;

      if (saved) {
        recipes.set(saved.id, saved.recipe);
      }
    }

    const withRecipes = entries.filter((entry) => entry.recipeId && recipes.has(entry.recipeId));
    const items = mergeShoppingInputs(
      buildShoppingInputsForPlan(withRecipes, recipes, { units })
    ).map(roundUpCountForShopping);

    return {
      items,
      mealCount: withRecipes.length,
      recipeCount: recipes.size,
      skippedCount: entries.length - withRecipes.length
    };
  }, [entries, recipesById, units]);

  const openKeys = useMemo(
    () =>
      new Set(
        listItems.filter((item) => !item.checked).map((item) => canonicalIngredientKey(item.text))
      ),
    [listItems]
  );
  const stapleIds = useMemo(
    () =>
      planned.items.flatMap((item, index) => (isPantryStaple(item.text) ? [String(index)] : [])),
    [planned.items]
  );
  const [includeStaples, setIncludeStaples] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        planned.items.flatMap((item, index) => (isPantryStaple(item.text) ? [] : [String(index)]))
      )
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const groups = useMemo<ShoppingChecklistGroup[]>(() => {
    const byCategory = new Map<string, Array<{ id: string; item: AggregatedShoppingItem }>>();

    planned.items.forEach((item, index) => {
      const bucket = byCategory.get(item.category) ?? [];
      bucket.push({ id: String(index), item });
      byCategory.set(item.category, bucket);
    });

    return SHOPPING_CATEGORIES.flatMap(({ id, label }) => {
      const bucket = byCategory.get(id);

      return bucket
        ? [
            {
              aisle: id,
              id,
              label,
              rows: bucket.map(({ id: rowId, item }) => ({
                detail: item.recipeTitles.join(" · "),
                id: rowId,
                label: formatShoppingItemText(item),
                onList: openKeys.has(item.key),
                staple: isPantryStaple(item.text)
              }))
            }
          ]
        : [];
    });
  }, [openKeys, planned.items]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  };

  const setStaples = (include: boolean) => {
    setIncludeStaples(include);
    setSelected((current) => {
      const next = new Set(current);
      stapleIds.forEach((id) => (include ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  const confirm = async () => {
    const chosen = planned.items.filter((_item, index) => selected.has(String(index)));

    if (chosen.length === 0 || submitting) {
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const writeOptions = getShoppingWriteOptions();
      await addParsedShoppingItems(
        chosen.map((item) => ({
          qty: item.qty,
          recipeIds: item.recipeIds,
          recipeTitles: item.recipeTitles,
          text: item.text,
          unit: item.unit
        })),
        writeOptions
      );
      requestShoppingSync({ delayMs: 0 });
      trackWebEvent({
        eventName: "meal_plan_shopping_generated",
        properties: {
          added_count: chosen.length,
          item_count: planned.items.length,
          meal_count: planned.mealCount,
          recipe_count: planned.recipeCount
        },
        routeOrScreen: "/plan"
      });
      trackWebEvent({
        eventName: "shopping_item_added",
        properties: { count: chosen.length, method: "meal_plan", source: "recipe" },
        routeOrScreen: "/plan"
      });
      showToast({
        action: {
          label: "View list",
          onClick: () => {
            void navigate("/shopping");
          }
        },
        icon: "shopping-basket",
        id: "plan-shopping",
        message: `Added ${chosen.length} ${chosen.length === 1 ? "item" : "items"} to your list`,
        tone: "success"
      });
      onClose();
    } catch (addError) {
      setError(getFriendlyErrorMessage(addError, "shopping"));
    } finally {
      setSubmitting(false);
    }
  };

  const count = selected.size;

  return (
    <Sheet
      description={`${weekLabel} · ${planned.recipeCount} ${planned.recipeCount === 1 ? "recipe" : "recipes"}, merged and sorted by aisle`}
      dismissible={!submitting}
      footer={
        planned.items.length > 0 ? (
          <>
            <Button disabled={submitting} onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={count === 0}
              icon="shopping-basket"
              loading={submitting}
              onClick={() => void confirm()}
            >
              {count === 0 ? "Pick some items" : `Add ${count} ${count === 1 ? "item" : "items"}`}
            </Button>
          </>
        ) : null
      }
      onClose={onClose}
      open={open}
      size="lg"
      testId="plan-shopping-sheet"
      title="Shop for the week"
    >
      {error ? (
        <p className="plan-sheet-error" role="alert">
          <Icon name="alert-circle" size={18} /> {error}
        </p>
      ) : null}
      {planned.skippedCount > 0 ? (
        <p className="plan-sheet-note">
          <Icon name="info" size={16} />
          {planned.skippedCount === 1
            ? "1 meal has no recipe (like leftovers), so it adds nothing."
            : `${planned.skippedCount} meals have no recipe (like leftovers), so they add nothing.`}
        </p>
      ) : null}
      {planned.items.length === 0 ? (
        <p className="plan-sheet-empty">
          Plan a recipe or two this week and their ingredients will show up here.
        </p>
      ) : (
        <ShoppingChecklist
          groups={groups}
          includeStaples={includeStaples}
          onIncludeStaplesChange={setStaples}
          onSelectAll={() =>
            setSelected(new Set(planned.items.map((_item, index) => String(index))))
          }
          onSelectNone={() => setSelected(new Set())}
          onToggle={toggle}
          selected={selected}
          stapleCount={stapleIds.length}
        />
      )}
    </Sheet>
  );
};
