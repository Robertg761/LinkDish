import React, { memo } from "react";

import { Icon } from "../../components/Icon";

import { splitIngredientQuantity } from "./recipe-scaling";

import type { IngredientGroup } from "./use-ingredient-checks";
import type { DisplayIngredient } from "@linkdish/recipe-domain";

import "./IngredientList.css";

interface IngredientLineProps {
  display: DisplayIngredient;
}

/** One displayed line with its leading amount in bold tabular figures (≈ when approximate). */
export const IngredientLine: React.FC<IngredientLineProps> = ({ display }) => {
  const { quantity, rest } = splitIngredientQuantity(display.text);

  return (
    <span className="ingredient-line">
      {quantity ? (
        <strong className="ingredient-line-qty num">
          {display.approximate ? (
            <span className="recipe-approx-mark" title="Approximate conversion">
              ≈
            </span>
          ) : null}
          {quantity}
        </strong>
      ) : null}
      {rest}
    </span>
  );
};

interface IngredientRowProps {
  checked: boolean;
  display: DisplayIngredient;
  itemKey: string;
  highlighted: boolean;
  onToggle?: ((key: string) => void) | undefined;
}

const IngredientRow = memo<IngredientRowProps>(
  ({ checked, display, itemKey, highlighted, onToggle }) => {
    if (!onToggle) {
      return (
        <li className={`ingredient-row is-static${highlighted ? " is-highlighted" : ""}`}>
          <span aria-hidden="true" className="ingredient-row-bullet" />
          <IngredientLine display={display} />
        </li>
      );
    }

    return (
      <li className="ingredient-row-item">
        <button
          aria-checked={checked}
          className={[
            "ingredient-row",
            checked ? "is-checked" : "",
            highlighted ? "is-highlighted" : ""
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onToggle(itemKey)}
          role="checkbox"
          type="button"
        >
          <span aria-hidden="true" className="ingredient-row-check">
            <Icon name="check" size={14} strokeWidth={3} />
          </span>
          <IngredientLine display={display} />
        </button>
      </li>
    );
  }
);

IngredientRow.displayName = "IngredientRow";

interface IngredientListProps {
  groups: readonly IngredientGroup[];
  displayIngredient: (text: string) => DisplayIngredient;
  checked?: ReadonlySet<string> | undefined;
  /** Lines to emphasize (the ones the current cook-mode step uses). */
  highlighted?: ReadonlySet<string> | undefined;
  /** Says why lines are emphasized ("Used in step 2"); shown above the list when any are. */
  highlightLabel?: string | undefined;
  /** Omit for a read-only list (no tick boxes). */
  onToggle?: ((key: string) => void) | undefined;
  className?: string | undefined;
  /** Heading level for section names. */
  sectionHeadingLevel?: 3 | 4 | undefined;
}

/** Ingredients grouped by section; tapping a line ticks it off (strike-through, muted). */
export const IngredientList: React.FC<IngredientListProps> = ({
  groups,
  displayIngredient,
  checked,
  highlighted,
  highlightLabel,
  onToggle,
  className = "",
  sectionHeadingLevel = 3
}) => {
  const SectionHeading = sectionHeadingLevel === 3 ? "h3" : "h4";
  const hasHighlights =
    highlighted != null &&
    highlighted.size > 0 &&
    groups.some((group) => group.items.some((item) => highlighted.has(item.key)));

  return (
    <div className={["ingredient-list", className].filter(Boolean).join(" ")}>
      {hasHighlights && highlightLabel ? (
        <p className="ingredient-list-legend">
          <span aria-hidden="true" className="ingredient-list-legend-swatch" />
          {highlightLabel}
        </p>
      ) : null}
      {groups.map((group) => (
        <div className="ingredient-group" key={group.key}>
          {group.section ? (
            <SectionHeading className="ingredient-group-title">{group.section}</SectionHeading>
          ) : null}
          <ul className="ingredient-group-items">
            {group.items.map((item) => (
              <IngredientRow
                checked={checked?.has(item.key) ?? false}
                display={displayIngredient(item.text)}
                highlighted={highlighted?.has(item.key) ?? false}
                itemKey={item.key}
                key={item.key}
                onToggle={onToggle}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};
