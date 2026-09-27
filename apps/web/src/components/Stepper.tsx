import React from "react";

import { Icon } from "./Icon";

import "./Stepper.css";

interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  /** Accessible name, e.g. "Servings". */
  label: string;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  /** Display text, e.g. (n) => `${n} servings`. Also used as aria-valuetext. */
  formatValue?: ((value: number) => string) | undefined;
  size?: "sm" | "md" | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * −/+ number control. The value is a spinbutton (ArrowUp/ArrowDown, Home/End,
 * PageUp/PageDown) and both buttons disable at the bounds.
 */
export const Stepper: React.FC<StepperProps> = ({
  value,
  onChange,
  label,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  formatValue,
  size = "md",
  disabled = false,
  className = ""
}) => {
  const display = formatValue ? formatValue(value) : String(value);
  const update = (next: number) => {
    const rounded = Math.round(next * 1000) / 1000;
    const clamped = clamp(rounded, min, max);

    if (clamped !== value) {
      onChange(clamped);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    const actions: Record<string, () => void> = {
      ArrowUp: () => update(value + step),
      ArrowRight: () => update(value + step),
      ArrowDown: () => update(value - step),
      ArrowLeft: () => update(value - step),
      PageUp: () => update(value + step * 10),
      PageDown: () => update(value - step * 10),
      Home: () => update(min),
      End: () => {
        if (max !== Number.MAX_SAFE_INTEGER) {
          update(max);
        }
      }
    };
    const action = actions[event.key];

    if (action && !disabled) {
      event.preventDefault();
      action();
    }
  };

  return (
    <div
      aria-label={label}
      className={["stepper", size === "sm" ? "stepper-sm" : "", className]
        .filter(Boolean)
        .join(" ")}
      role="group"
    >
      <button
        aria-label={`Decrease ${label.toLowerCase()}`}
        className="stepper-button"
        disabled={disabled || value <= min}
        onClick={() => update(value - step)}
        type="button"
      >
        <Icon name="minus" size={size === "sm" ? 16 : 18} strokeWidth={2.4} />
      </button>
      <span
        aria-disabled={disabled || undefined}
        aria-label={label}
        aria-valuemax={max === Number.MAX_SAFE_INTEGER ? undefined : max}
        aria-valuemin={min}
        aria-valuenow={value}
        aria-valuetext={display}
        className="stepper-value num"
        onKeyDown={handleKeyDown}
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
      >
        {display}
      </span>
      <button
        aria-label={`Increase ${label.toLowerCase()}`}
        className="stepper-button"
        disabled={disabled || value >= max}
        onClick={() => update(value + step)}
        type="button"
      >
        <Icon name="plus" size={size === "sm" ? 16 : 18} strokeWidth={2.4} />
      </button>
    </div>
  );
};
