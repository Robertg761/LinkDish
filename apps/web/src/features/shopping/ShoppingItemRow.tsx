import React, { memo } from "react";

import { Icon } from "../../components/Icon";

import { formatItemAmount } from "./shopping-format";
import { getItemRecipeTitles } from "./shopping-list-store";

import type { WebShoppingItem } from "./shopping-list-store";

interface ShoppingItemRowProps {
  item: WebShoppingItem;
  /** Shown checked while it animates into the cart. */
  checking?: boolean | undefined;
  /** Just moved here; plays the entrance animation. */
  entering?: boolean | undefined;
  /** Hide the recipe chips (e.g. inside a recipe group, where the heading says it). */
  hideRecipe?: string | undefined;
  onToggle: (item: WebShoppingItem) => void;
  onEdit: (item: WebShoppingItem) => void;
  onRemove: (item: WebShoppingItem) => void;
}

const MAX_CHIPS = 2;

/**
 * One shopping line: a big round checkbox, the amount in tabular numerals and the name (tap to
 * edit), the recipes it came from, and a quiet remove button.
 */
const ShoppingItemRowComponent: React.FC<ShoppingItemRowProps> = ({
  item,
  checking = false,
  entering = false,
  hideRecipe,
  onToggle,
  onEdit,
  onRemove
}) => {
  const amount = formatItemAmount(item);
  const checked = item.checked || checking;
  const recipes = getItemRecipeTitles(item).filter((title) => title !== hideRecipe);
  const shown = recipes.slice(0, MAX_CHIPS);
  const extra = recipes.length - shown.length;
  const label = amount ? `${amount} ${item.text}` : item.text;
  const conflict = item.sync.status === "sync_failed";

  return (
    <li
      className={[
        "shopping-row",
        checked ? "is-checked" : "",
        checking ? "is-checking" : "",
        entering ? "is-entering" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        aria-checked={checked}
        aria-label={label}
        className="shopping-row-check"
        onClick={() => onToggle(item)}
        role="checkbox"
        type="button"
      >
        <span aria-hidden="true" className="shopping-row-box">
          <Icon name="check" size={16} strokeWidth={3} />
        </span>
      </button>
      <button
        aria-label={`Edit ${label}`}
        className="shopping-row-main"
        onClick={() => onEdit(item)}
        type="button"
      >
        <span className="shopping-row-text">
          {amount ? <span className="shopping-row-amount num">{amount}</span> : null}{" "}
          <span className="shopping-row-name">{item.text}</span>
        </span>
        {shown.length > 0 || conflict ? (
          <span className="shopping-row-meta">
            {shown.map((title) => (
              <span className="shopping-row-recipe" key={title}>
                {title}
              </span>
            ))}
            {extra > 0 ? <span className="shopping-row-recipe is-more">+{extra}</span> : null}
            {conflict ? (
              <span className="shopping-row-conflict">
                <Icon name="alert-circle" size={12} /> Not shared yet
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      <button
        aria-label={`Remove ${label}`}
        className="shopping-row-remove"
        onClick={() => onRemove(item)}
        type="button"
      >
        <Icon name="x" size={18} />
      </button>
    </li>
  );
};

export const ShoppingItemRow = memo(ShoppingItemRowComponent);
