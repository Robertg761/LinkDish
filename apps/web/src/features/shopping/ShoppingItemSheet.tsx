import React, { useEffect, useState } from "react";

import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Sheet } from "../../components/Sheet";

import { formatItem } from "./shopping-format";
import { getItemRecipeTitles } from "./shopping-list-store";

import type { WebShoppingItem } from "./shopping-list-store";

interface ShoppingItemSheetProps {
  item: WebShoppingItem | null;
  onClose: () => void;
  onSave: (item: WebShoppingItem, line: string) => void;
  onRemove: (item: WebShoppingItem) => void;
}

/** Edit one item as a single line ("3 cups oat milk"); the amount is read from it. */
export const ShoppingItemSheet: React.FC<ShoppingItemSheetProps> = ({
  item,
  onClose,
  onSave,
  onRemove
}) => {
  const [value, setValue] = useState("");
  const recipes = item ? getItemRecipeTitles(item) : [];

  useEffect(() => {
    if (item) {
      setValue(formatItem(item));
    }
  }, [item]);

  const save = () => {
    if (!item || !value.trim()) {
      return;
    }

    onSave(item, value);
  };

  return (
    <Sheet
      footer={
        item ? (
          <>
            <Button icon="trash" onClick={() => onRemove(item)} variant="outline-danger">
              Remove
            </Button>
            <Button disabled={!value.trim()} onClick={save}>
              Save
            </Button>
          </>
        ) : null
      }
      onClose={onClose}
      open={item !== null}
      size="sm"
      title="Edit item"
    >
      <form
        className="shopping-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field
          autoFocus
          hint='Start with an amount to change it, like "2 cups" or "3".'
          label="Item"
          maxLength={220}
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
      </form>
      {recipes.length > 0 ? (
        <div className="shopping-edit-recipes">
          <span className="shopping-edit-recipes-label">For</span>
          <ul>
            {recipes.map((title) => (
              <li className="shopping-row-recipe" key={title}>
                {title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Sheet>
  );
};
