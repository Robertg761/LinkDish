import {
  canonicalIngredientKey,
  formatShoppingItemText,
  getIngredientUnitSummary,
  isPantryStaple,
  parseServings,
  parseShoppingLine
} from "@linkdish/recipe-domain";
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
import { usePreference } from "../../preferences/preferences-store";

import {
  addShoppingItems,
  recipeIngredientsToShoppingInputs,
  roundUpCountForShopping,
  useShoppingList,
  type ShoppingScaling
} from "./shopping-list-store";
import { getShoppingWriteOptions, requestShoppingSync } from "./shopping-sync";
import { ShoppingChecklist } from "./ShoppingChecklist";

import type { ShoppingChecklistGroup } from "./ShoppingChecklist";
import type { IngredientUnitsPreference, Recipe } from "@linkdish/recipe-domain";

import "./AddRecipeToShoppingSheet.css";

export interface AddRecipeToShoppingSheetProps {
  /** Defaults to true so callers can mount the sheet conditionally. */
  open?: boolean | undefined;
  onClose: () => void;
  /** Called with the number of ingredients added. */
  onAdded?: ((count: number) => void) | undefined;
  recipe: Recipe;
  recipeId: string;
  /** Current scale and units on the recipe page (factor 1, original units by default). */
  scaling?: ShoppingScaling | undefined;
  /** Household sync; defaults to what the shopping sync layer knows about this account. */
  canSync?: boolean | undefined;
  userId?: string | undefined;
}

const UNIT_OPTIONS = [
  { label: "As written", value: "original" },
  { label: "US", value: "us" },
  { label: "Metric", value: "metric" }
] as const;

const initialUnits = (
  recipe: Recipe,
  scaling: ShoppingScaling | undefined,
  preferred: IngredientUnitsPreference
): IngredientUnitsPreference => {
  if (scaling?.units) {
    return scaling.units;
  }

  if (scaling?.unitPreference === "alternate") {
    return getIngredientUnitSummary(recipe.ingredients).primarySystem === "metric"
      ? "us"
      : "metric";
  }

  return preferred;
};

const roundScale = (value: number) => Math.round(value * 100) / 100;

/**
 * "Add ingredients to your shopping list": pick servings and units, untick what you have, see
 * what's already on the list, then add in one go (merged with the list, amounts summed).
 */
export const AddRecipeToShoppingSheet: React.FC<AddRecipeToShoppingSheetProps> = ({
  open = true,
  onClose,
  onAdded,
  recipe,
  recipeId,
  scaling,
  canSync,
  userId
}) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const preferredUnits = usePreference("units");
  const { items: listItems } = useShoppingList();
  const baseServings = useMemo(() => parseServings(recipe.servings)?.min ?? null, [recipe]);
  const initialFactor = scaling?.factor && scaling.factor > 0 ? scaling.factor : 1;
  const [servings, setServings] = useState<number>(() =>
    baseServings ? Math.max(1, Math.round(baseServings * initialFactor)) : 1
  );
  const [factor, setFactor] = useState<number>(initialFactor);
  const [units, setUnits] = useState<IngredientUnitsPreference>(() =>
    initialUnits(recipe, scaling, preferredUnits)
  );
  const canConvert = useMemo(
    () => getIngredientUnitSummary(recipe.ingredients).canConvert,
    [recipe]
  );
  const scale = baseServings ? servings / baseServings : factor;
  const inputs = useMemo(
    () => recipeIngredientsToShoppingInputs(recipe, recipeId, { factor: scale, units }),
    [recipe, recipeId, scale, units]
  );
  const openKeys = useMemo(
    () =>
      new Set(
        listItems.filter((item) => !item.checked).map((item) => canonicalIngredientKey(item.text))
      ),
    [listItems]
  );
  const rows = useMemo(
    () =>
      inputs
        .map((input, index) => {
          const parsed = roundUpCountForShopping(parseShoppingLine(input.text));

          return {
            id: String(index),
            input,
            label: formatShoppingItemText(parsed),
            onList: openKeys.has(canonicalIngredientKey(input.text)),
            section: input.section?.trim() || "",
            staple: isPantryStaple(input.text),
            usable: parsed.text.trim().length > 0
          };
        })
        .filter((row) => row.usable),
    [inputs, openKeys]
  );
  const stapleIds = useMemo(() => rows.filter((row) => row.staple).map((row) => row.id), [rows]);
  const [includeStaples, setIncludeStaples] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.filter((row) => !row.staple).map((row) => row.id))
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const groups = useMemo<ShoppingChecklistGroup[]>(() => {
    const result: ShoppingChecklistGroup[] = [];

    rows.forEach((row) => {
      const current = result[result.length - 1];

      if (!current || current.label !== (row.section || undefined)) {
        result.push({ id: `group-${row.id}`, label: row.section || undefined, rows: [] });
      }

      result[result.length - 1]?.rows.push({
        id: row.id,
        label: row.label,
        onList: row.onList,
        staple: row.staple
      });
    });

    return result;
  }, [rows]);

  const selectedInputs = rows.filter((row) => selected.has(row.id)).map((row) => row.input);

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

  const confirmAdd = async () => {
    if (selectedInputs.length === 0 || submitting) {
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const defaults = getShoppingWriteOptions();
      const writeOptions = {
        canSync: canSync ?? defaults.canSync,
        ...((userId ?? defaults.userId) ? { userId: userId ?? defaults.userId } : {})
      };
      await addShoppingItems(selectedInputs, writeOptions);

      if (writeOptions.canSync) {
        requestShoppingSync({ delayMs: 0 });
      }

      const count = selectedInputs.length;
      trackWebEvent({
        eventName: "shopping_item_added",
        properties: { count, method: "recipe_sheet", source: "recipe" },
        routeOrScreen: window.location.pathname
      });
      showToast({
        action: {
          label: "View list",
          onClick: () => {
            void navigate("/shopping");
          }
        },
        icon: "shopping-basket",
        id: "shopping-added",
        message: `Added ${count} ${count === 1 ? "item" : "items"} to your list`,
        tone: "success"
      });
      onAdded?.(count);
      onClose();
    } catch (addError) {
      setError(getFriendlyErrorMessage(addError, "shopping"));
    } finally {
      setSubmitting(false);
    }
  };

  const count = selectedInputs.length;

  return (
    <Sheet
      className="add-to-shopping-sheet"
      description={recipe.title}
      dismissible={!submitting}
      footer={
        <>
          <Button disabled={submitting} onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={count === 0}
            icon="shopping-basket"
            loading={submitting}
            onClick={() => {
              void confirmAdd();
            }}
          >
            {count === 0 ? "Pick some items" : `Add ${count} ${count === 1 ? "item" : "items"}`}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      testId="add-to-shopping-sheet"
      title="Add ingredients"
    >
      <div className="add-to-shopping-controls">
        {baseServings ? (
          <div className="add-to-shopping-control">
            <span className="add-to-shopping-control-label">Servings</span>
            <Stepper
              formatValue={(value) => String(value)}
              label="Servings"
              max={99}
              min={1}
              onChange={setServings}
              size="sm"
              value={servings}
            />
          </div>
        ) : (
          <div className="add-to-shopping-control">
            <span className="add-to-shopping-control-label">Scale</span>
            <Stepper
              formatValue={(value) => `${value}×`}
              label="Scale"
              max={12}
              min={0.5}
              onChange={(value) => setFactor(roundScale(value))}
              size="sm"
              step={0.5}
              value={factor}
            />
          </div>
        )}
        {canConvert ? (
          <SegmentedControl
            aria-label="Units"
            className="add-to-shopping-units"
            onChange={setUnits}
            options={UNIT_OPTIONS}
            size="sm"
            value={units}
          />
        ) : null}
      </div>

      {error ? (
        <p className="add-to-shopping-error" role="alert">
          <Icon name="alert-circle" size={18} /> {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="add-to-shopping-empty">This recipe has no ingredients to add yet.</p>
      ) : (
        <ShoppingChecklist
          groups={groups}
          includeStaples={includeStaples}
          onIncludeStaplesChange={setStaples}
          onSelectAll={() => setSelected(new Set(rows.map((row) => row.id)))}
          onSelectNone={() => setSelected(new Set())}
          onToggle={toggle}
          selected={selected}
          stapleCount={stapleIds.length}
        />
      )}
    </Sheet>
  );
};
