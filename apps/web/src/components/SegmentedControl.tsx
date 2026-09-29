import React, { useRef } from "react";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./SegmentedControl.css";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  icon?: IconName | undefined;
  disabled?: boolean | undefined;
}

interface SegmentedControlProps<T extends string | number> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  size?: "sm" | "md" | undefined;
  fullWidth?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A single-choice control (radiogroup) with roving focus: Tab lands on the selected
 * option and the arrow keys move and select, like native radio buttons.
 */
export const SegmentedControl = <T extends string | number>({
  options,
  value,
  onChange,
  size = "md",
  fullWidth = false,
  className = "",
  "aria-label": ariaLabel
}: SegmentedControlProps<T>): React.ReactElement => {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabledIndexes = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);

  const moveTo = (index: number) => {
    const option = options[index];

    if (!option) {
      return;
    }

    onChange(option.value);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const position = enabledIndexes.indexOf(index);
    let nextIndex: number | undefined;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = enabledIndexes[(position + 1) % enabledIndexes.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = enabledIndexes[(position - 1 + enabledIndexes.length) % enabledIndexes.length];
    } else if (event.key === "Home") {
      nextIndex = enabledIndexes[0];
    } else if (event.key === "End") {
      nextIndex = enabledIndexes[enabledIndexes.length - 1];
    }

    if (nextIndex !== undefined) {
      event.preventDefault();
      moveTo(nextIndex);
    }
  };

  const hasSelection = options.some((option) => option.value === value);

  return (
    <div
      aria-label={ariaLabel}
      className={[
        "segmented",
        size === "sm" ? "segmented-sm" : "",
        fullWidth ? "segmented-full" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      role="radiogroup"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const tabbable = selected || (!hasSelection && index === enabledIndexes[0]);

        return (
          <button
            aria-checked={selected}
            className={`segmented-option${selected ? " is-selected" : ""}`}
            disabled={option.disabled}
            key={String(option.value)}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            role="radio"
            tabIndex={tabbable ? 0 : -1}
            type="button"
          >
            {option.icon ? <Icon name={option.icon} size={size === "sm" ? 15 : 17} /> : null}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
};
