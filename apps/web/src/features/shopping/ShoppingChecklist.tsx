import React from "react";

import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";

import { AisleIcon } from "./AisleIcon";

import type { ShoppingCategoryId } from "@linkdish/recipe-domain";

import "./ShoppingChecklist.css";

export interface ShoppingChecklistRow {
  id: string;
  /** Main line, e.g. "⅔ cup brown sugar". */
  label: string;
  /** Quiet second line, e.g. the recipes it comes from. */
  detail?: string | undefined;
  onList?: boolean | undefined;
  staple?: boolean | undefined;
}

export interface ShoppingChecklistGroup {
  id: string;
  label?: string | undefined;
  aisle?: ShoppingCategoryId | undefined;
  rows: ShoppingChecklistRow[];
}

interface ShoppingChecklistProps {
  groups: readonly ShoppingChecklistGroup[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  includeStaples: boolean;
  onIncludeStaplesChange: (include: boolean) => void;
  /** The staples in this list ("water", "table salt"); the switch hides when there are none. */
  stapleNames: readonly string[];
}

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "Water is left off: you probably have it." / "Salt, pepper and 2 more are left off: …" */
export const describeStaples = (names: readonly string[]): string => {
  const unique = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];

  if (unique.length === 0) {
    return "";
  }

  if (unique.length === 1) {
    return `${capitalize(unique[0] ?? "")} is left off: you probably have it.`;
  }

  const shown = unique.slice(0, 2);
  const more = unique.length - shown.length;
  const list =
    more > 0 ? `${shown.join(", ")} and ${more} more` : `${shown[0] ?? ""} and ${shown[1] ?? ""}`;
  return `${capitalize(list)} are left off: you probably have them.`;
};

/**
 * The pick-what-to-add list used before anything lands on the shopping list: grouped rows with
 * big checkboxes, "On your list" markers, select all/none and a pantry-staples switch.
 */
export const ShoppingChecklist: React.FC<ShoppingChecklistProps> = ({
  groups,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  includeStaples,
  onIncludeStaplesChange,
  stapleNames
}) => {
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const onListCount = groups.reduce(
    (sum, group) => sum + group.rows.filter((row) => row.onList).length,
    0
  );

  return (
    <div className="shopping-checklist">
      <div className="shopping-checklist-toolbar">
        <p className="shopping-checklist-count">
          <span className="num">{selected.size}</span> of <span className="num">{total}</span>{" "}
          selected
        </p>
        <div className="shopping-checklist-bulk">
          <button
            className="shopping-checklist-link"
            disabled={selected.size === total}
            onClick={onSelectAll}
            type="button"
          >
            Select all
          </button>
          <span aria-hidden="true" className="shopping-checklist-dot">
            ·
          </span>
          <button
            className="shopping-checklist-link"
            disabled={selected.size === 0}
            onClick={onSelectNone}
            type="button"
          >
            None
          </button>
        </div>
      </div>

      {stapleNames.length > 0 ? (
        <Switch
          checked={includeStaples}
          className="shopping-checklist-staples"
          description={describeStaples(stapleNames)}
          label="Include pantry staples"
          onChange={onIncludeStaplesChange}
        />
      ) : null}

      {/* One summary instead of an "On your list" badge on every row. */}
      {onListCount > 0 ? (
        <p className="shopping-checklist-onlist">
          <Icon name="list-checks" size={16} />
          <span>
            <strong className="num">{onListCount}</strong> {onListCount === 1 ? "is" : "are"}{" "}
            already on your list. Adding merges the amounts.
          </span>
        </p>
      ) : null}

      {groups.map((group) => (
        <section
          aria-label={group.label ?? "Ingredients"}
          className="shopping-checklist-group"
          key={group.id}
        >
          {group.label ? (
            <h3 className="shopping-checklist-heading">
              {group.aisle ? (
                <span className="shopping-checklist-aisle" aria-hidden="true">
                  <AisleIcon category={group.aisle} size={16} />
                </span>
              ) : null}
              {group.label}
            </h3>
          ) : null}
          <ul className="shopping-checklist-rows">
            {group.rows.map((row) => {
              const isSelected = selected.has(row.id);

              return (
                <li key={row.id}>
                  <button
                    aria-checked={isSelected}
                    className={`shopping-checklist-row${isSelected ? " is-selected" : ""}`}
                    onClick={() => onToggle(row.id)}
                    role="checkbox"
                    type="button"
                  >
                    <span aria-hidden="true" className="shopping-checklist-box">
                      <Icon name="check" size={15} strokeWidth={3} />
                    </span>
                    <span className="shopping-checklist-copy">
                      <span className="shopping-checklist-label">{row.label}</span>
                      {row.detail || row.onList || row.staple ? (
                        <span className="shopping-checklist-meta">
                          {row.onList ? (
                            <span className="shopping-checklist-mark">
                              <Icon name="check" size={12} strokeWidth={2.6} /> On your list
                            </span>
                          ) : null}
                          {row.staple ? (
                            <span className="shopping-checklist-mark">Pantry staple</span>
                          ) : null}
                          {row.detail ? (
                            <span className="shopping-checklist-detail">{row.detail}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
};
