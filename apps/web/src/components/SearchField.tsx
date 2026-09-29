import React, { useRef } from "react";

import { Icon } from "./Icon";

import "./SearchField.css";

interface SearchFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "type" | "size"
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name; defaults to the placeholder. */
  "aria-label"?: string | undefined;
  /** Called after the clear button (or Escape) empties the field. */
  onClear?: (() => void) | undefined;
  /** Keyboard shortcut hint shown while the field is empty, e.g. "⌘K". */
  shortcutHint?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement> | undefined;
  size?: "md" | "lg" | undefined;
}

export const SearchField: React.FC<SearchFieldProps> = ({
  value,
  onValueChange,
  onClear,
  shortcutHint,
  inputRef,
  placeholder = "Search",
  className = "",
  size = "md",
  onKeyDown,
  "aria-label": ariaLabel,
  ...props
}) => {
  const localRef = useRef<HTMLInputElement | null>(null);

  const setRefs = (element: HTMLInputElement | null) => {
    localRef.current = element;

    if (typeof inputRef === "function") {
      inputRef(element);
    } else if (inputRef) {
      inputRef.current = element;
    }
  };

  const clear = () => {
    onValueChange("");
    onClear?.();
    localRef.current?.focus();
  };

  return (
    <div
      className={["search-field", size === "lg" ? "search-field-lg" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <Icon name="search" size={size === "lg" ? 20 : 18} className="search-field-icon" />
      <input
        {...props}
        aria-label={ariaLabel ?? placeholder}
        className="search-field-input"
        enterKeyHint="search"
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);

          if (!event.defaultPrevented && event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
        }}
        placeholder={placeholder}
        ref={setRefs}
        type="search"
        value={value}
      />
      {value ? (
        <button
          aria-label="Clear search"
          className="search-field-clear"
          onClick={clear}
          type="button"
        >
          <Icon name="x" size={16} strokeWidth={2.4} />
        </button>
      ) : shortcutHint ? (
        <kbd className="search-field-hint" aria-hidden="true">
          {shortcutHint}
        </kbd>
      ) : null}
    </div>
  );
};
