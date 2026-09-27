import React from "react";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./Chip.css";

export type ChipVariant = "default" | "accent" | "tomato" | "butter" | "outline";

interface ChipProps {
  children: React.ReactNode;
  /** default = neutral, accent = sage, tomato / butter = brand highlights, outline = quiet. */
  variant?: ChipVariant | undefined;
  size?: "sm" | "md" | undefined;
  icon?: IconName | undefined;
  className?: string | undefined;
}

/** A static, non-interactive label. Use FilterChip for toggles. */
export const Chip: React.FC<ChipProps> = ({
  children,
  variant = "default",
  size = "md",
  icon,
  className = ""
}) => {
  return (
    <span
      className={["chip", `chip-${variant}`, size === "sm" ? "chip-sm" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? 12 : 14} /> : null}
      {children}
    </span>
  );
};

interface FilterChipProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "children"
> {
  children: React.ReactNode;
  selected: boolean;
  onSelectedChange?: ((selected: boolean) => void) | undefined;
  /** Optional result count shown after the label. */
  count?: number | undefined;
  icon?: IconName | undefined;
}

/** A toggle chip for filters (aria-pressed). Shows a check when selected. */
export const FilterChip: React.FC<FilterChipProps> = ({
  children,
  selected,
  onSelectedChange,
  onClick,
  count,
  icon,
  className = "",
  type = "button",
  ...props
}) => {
  return (
    <button
      aria-pressed={selected}
      className={["filter-chip", selected ? "is-selected" : "", className]
        .filter(Boolean)
        .join(" ")}
      onClick={(event) => {
        onClick?.(event);

        if (!event.defaultPrevented) {
          onSelectedChange?.(!selected);
        }
      }}
      type={type}
      {...props}
    >
      {selected ? (
        <Icon name="check" size={15} className="filter-chip-check" />
      ) : icon ? (
        <Icon name={icon} size={15} />
      ) : null}
      <span className="filter-chip-label">{children}</span>
      {typeof count === "number" ? <span className="filter-chip-count num">{count}</span> : null}
    </button>
  );
};
