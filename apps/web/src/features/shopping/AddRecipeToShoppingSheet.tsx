import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { trackWebEvent } from "../../analytics/client";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

import {
  addShoppingItems,
  recipeIngredientsToShoppingInputs,
  syncShoppingItems,
  type AddShoppingItemInput
} from "./shopping-list-store";

import type { RecipeScalingState } from "../recipes/CookMode";
import type { Recipe } from "@linkdish/recipe-domain";
import "./AddRecipeToShoppingSheet.css";

interface AddRecipeToShoppingSheetProps {
  canSync: boolean;
  onClose: () => void;
  onAdded?: (count: number) => void;
  recipe: Recipe;
  recipeId: string;
  scaling: RecipeScalingState;
  userId?: string | undefined;
}

const groupInputs = (inputs: AddShoppingItemInput[]) => {
  const groups: Array<{ key: string; section: string | null; inputs: AddShoppingItemInput[] }> = [];

  inputs.forEach((input, index) => {
    const section = input.section?.trim() || null;
    const currentGroup = groups[groups.length - 1];

    if (!currentGroup || currentGroup.section !== section) {
      groups.push({
        inputs: [],
        key: `${section ?? "ingredients"}-${index}`,
        section
      });
    }

    groups[groups.length - 1]?.inputs.push(input);
  });

  return groups;
};

export const AddRecipeToShoppingSheet: React.FC<AddRecipeToShoppingSheetProps> = ({
  canSync,
  onAdded,
  onClose,
  recipe,
  recipeId,
  scaling,
  userId
}) => {
  const inputs = useMemo(
    () => recipeIngredientsToShoppingInputs(recipe, recipeId, scaling),
    [recipe, recipeId, scaling]
  );
  const [selectedTexts, setSelectedTexts] = useState<Set<string>>(
    () => new Set(inputs.map((input) => input.text))
  );
  const [submitting, setSubmitting] = useState(false);
  const groups = useMemo(() => groupInputs(inputs), [inputs]);
  const selectedInputs = inputs.filter((input) => selectedTexts.has(input.text));

  const toggleInput = (text: string) => {
    setSelectedTexts((current) => {
      const next = new Set(current);

      if (next.has(text)) {
        next.delete(text);
      } else {
        next.add(text);
      }

      return next;
    });
  };

  const confirmAdd = async () => {
    if (selectedInputs.length === 0) {
      return;
    }

    setSubmitting(true);

    try {
      await addShoppingItems(selectedInputs, { canSync, userId });
      if (canSync) {
        await syncShoppingItems({ canSync: true });
      }
      trackWebEvent({
        eventName: "shopping_item_added",
        routeOrScreen: window.location.pathname,
        properties: {
          count: selectedInputs.length,
          source: "recipe"
        }
      });
      onAdded?.(selectedInputs.length);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="shopping-sheet-backdrop" role="presentation">
      <section
        aria-labelledby="shopping-sheet-title"
        className="shopping-sheet"
        role="dialog"
        aria-modal="true"
      >
        <div className="shopping-sheet-header">
          <div>
            <p className="shopping-sheet-eyebrow">Shopping list</p>
            <h2 id="shopping-sheet-title">Add ingredients</h2>
          </div>
          <button
            aria-label="Close add ingredients"
            className="shopping-sheet-close"
            onClick={onClose}
            type="button"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="shopping-sheet-list">
          {groups.map((group) => (
            <div className="shopping-sheet-group" key={group.key}>
              {group.section ? <p className="shopping-sheet-section">{group.section}</p> : null}
              {group.inputs.map((input) => {
                const selected = selectedTexts.has(input.text);

                return (
                  <button
                    aria-checked={selected}
                    className={`shopping-sheet-row${selected ? " is-selected" : ""}`}
                    key={`${input.section ?? "base"}-${input.text}`}
                    onClick={() => toggleInput(input.text)}
                    role="checkbox"
                    type="button"
                  >
                    <span className="shopping-sheet-check">
                      {selected ? <Icon name="check" size={13} /> : null}
                    </span>
                    <span>{input.text}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="shopping-sheet-actions">
          <Button onClick={confirmAdd} loading={submitting} disabled={selectedInputs.length === 0}>
            Add {selectedInputs.length || ""} item{selectedInputs.length === 1 ? "" : "s"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </section>
    </div>,
    document.body
  );
};
