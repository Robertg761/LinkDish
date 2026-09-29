import React from "react";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./IconButton.css";

export type IconButtonVariant = "ghost" | "tonal" | "outline" | "filled" | "accent" | "danger";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children"
> {
  icon: IconName;
  /** Required: icon-only buttons have no visible text. */
  "aria-label": string;
  variant?: IconButtonVariant | undefined;
  size?: IconButtonSize | undefined;
  /** Toggle state for on/off buttons such as a favorite heart (sets aria-pressed). */
  pressed?: boolean | undefined;
  /** Icon shown while `pressed` is true, e.g. "heart-filled". */
  pressedIcon?: IconName | undefined;
  iconSize?: number | undefined;
  ref?: React.Ref<HTMLButtonElement> | undefined;
}

const DEFAULT_ICON_SIZE: Record<IconButtonSize, number> = { sm: 18, md: 20, lg: 24 };

export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  variant = "ghost",
  size = "md",
  pressed,
  pressedIcon,
  iconSize,
  className = "",
  type = "button",
  ref,
  ...props
}) => {
  const shownIcon = pressed && pressedIcon ? pressedIcon : icon;

  return (
    <button
      aria-pressed={pressed}
      className={[
        "icon-btn",
        `icon-btn-${variant}`,
        `icon-btn-${size}`,
        pressed ? "is-pressed" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      ref={ref}
      type={type}
      {...props}
    >
      <Icon name={shownIcon} size={iconSize ?? DEFAULT_ICON_SIZE[size]} />
    </button>
  );
};
