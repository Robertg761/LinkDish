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
  /**
   * Inside a recipe group: that recipe's title. The group heading already names it, so the row
   * only says which other recipes share the item ("Also in Banana Bread").
   */
  groupRecipe?: string | undefined;
  onToggle: (item: WebShoppingItem) => void;
  onEdit: (item: WebShoppingItem) => void;
  onRemove: (item: WebShoppingItem) => void;
}

/** "Jo Mama's Spaghetti", "Jo Mama's Spaghetti +1" (one quiet line, never a row of chips). */
const summarizeTitles = (titles: readonly string[]): string | null =>
  titles.length === 0
    ? null
    : titles.length === 1
      ? (titles[0] ?? null)
      : `${titles[0] ?? ""} +${titles.length - 1}`;

/**
 * One shopping line: a big round checkbox, the amount in tabular numerals and the name (tap to
 * edit), a muted line saying which recipes it's for, and a quiet remove button.
 */
const ShoppingItemRowComponent: React.FC<ShoppingItemRowProps> = ({
  item,
  checking = false,
  entering = false,
  groupRecipe,
  onToggle,
  onEdit,
  onRemove
}) => {
  const amount = formatItemAmount(item);
  const checked = item.checked || checking;
  const titles = getItemRecipeTitles(item);
  const others = groupRecipe ? titles.filter((title) => title !== groupRecipe) : titles;
  const summary = summarizeTitles(others);
  const source = summary ? (groupRecipe ? `Also in ${summary}` : `For ${summary}`) : null;
  const label = amount ? `${amount} ${item.text}` : item.text;
  const conflict = item.sync.status === "sync_failed";

  return (
    <li
      data-item-id={item.id}
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
        {source || conflict ? (
          <span className="shopping-row-meta">
            {source ? <span className="shopping-row-source">{source}</span> : null}
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
