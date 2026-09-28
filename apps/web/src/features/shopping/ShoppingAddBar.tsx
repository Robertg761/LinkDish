import React, { useId, useMemo, useRef, useState } from "react";

import { Icon } from "../../components/Icon";

import { getShoppingSuggestions } from "./shopping-format";
import { splitShoppingLines } from "./shopping-list-store";

export type ShoppingAddMethod = "quick_add" | "paste" | "suggestion";

interface ShoppingAddBarProps {
  onAdd: (lines: string[], method: ShoppingAddMethod) => void;
  /** Canonical keys already on the open list (not suggested again). */
  excludeKeys: ReadonlySet<string>;
  /** Keep the "buy again" chips visible even when the field isn't focused. */
  alwaysShowSuggestions?: boolean | undefined;
  /** Bumped by the parent after history changes so suggestions refresh. */
  historyVersion?: number | undefined;
}

/**
 * The add field: type an item ("2 lemons"), paste a whole list (one item per line), or tap a
 * "buy again" chip. Enter adds; the field keeps focus for the next item.
 */
export const ShoppingAddBar: React.FC<ShoppingAddBarProps> = ({
  onAdd,
  excludeKeys,
  alwaysShowSuggestions = false,
  historyVersion = 0
}) => {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const suggestions = useMemo(
    () => getShoppingSuggestions(value, { exclude: excludeKeys, limit: 8 }),
    // historyVersion re-reads the stored history after adds.
    [value, excludeKeys, historyVersion]
  );
  const showSuggestions =
    (focused || alwaysShowSuggestions || value.length > 0) && suggestions.length > 0;

  const submit = () => {
    const lines = splitShoppingLines(value);

    if (lines.length === 0) {
      return;
    }

    onAdd(lines, lines.length > 1 ? "paste" : "quick_add");
    setValue("");
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");

    if (!/\r?\n/u.test(pasted.trim())) {
      return;
    }

    event.preventDefault();
    const lines = [...splitShoppingLines(value), ...splitShoppingLines(pasted)];

    if (lines.length > 0) {
      onAdd(lines, "paste");
      setValue("");
    }
  };

  return (
    <div
      className="shopping-add"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      onFocus={() => setFocused(true)}
    >
      <form
        className="shopping-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Icon className="shopping-add-icon" name="plus" size={22} />
        <input
          aria-describedby={hintId}
          aria-label="Add an item"
          autoComplete="off"
          className="shopping-add-input"
          enterKeyHint="done"
          onChange={(event) => setValue(event.target.value)}
          onPaste={handlePaste}
          placeholder="Add milk, 2 lemons…"
          ref={inputRef}
          value={value}
        />
        <button className="shopping-add-submit" disabled={!value.trim()} type="submit">
          Add
        </button>
      </form>
      <p className="sr-only" id={hintId}>
        Paste several lines to add one item per line.
      </p>
      {showSuggestions ? (
        <div className={`shopping-add-suggestions${value.trim() ? " is-typing" : ""}`}>
          <span className="shopping-add-suggestions-label">
            {value.trim() ? "Suggestions" : "Buy again"}
          </span>
          <ul aria-label="Quick add" className="shopping-add-chips">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  aria-label={`Add ${suggestion}`}
                  className="shopping-add-chip"
                  onClick={() => {
                    onAdd([suggestion], "suggestion");
                    setValue("");
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  type="button"
                >
                  <Icon name="plus" size={14} />
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
