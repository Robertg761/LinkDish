import React from "react";
import { Link, type LinkProps } from "react-router-dom";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./Button.css";

/**
 * - primary: forest fill — the one main action on a screen.
 * - accent: tomato fill — energetic, used sparingly (Add recipe, start cooking).
 * - secondary: raised surface with a hairline border — the everyday companion button.
 * - tonal: soft sage fill.
 * - outline: transparent with a border, forest text.
 * - ghost: text-only.
 * - danger / outline-danger: destructive actions.
 */
export type ButtonVariant =
  | "primary"
  | "accent"
  | "secondary"
  | "tonal"
  | "outline"
  | "ghost"
  | "danger"
  | "outline-danger";

export type ButtonSize = "sm" | "md" | "lg";

interface ButtonStyleProps {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  fullWidth?: boolean | undefined;
  /** Fully rounded ends instead of the 14px radius. */
  pill?: boolean | undefined;
  /** Icon rendered before the label. */
  icon?: IconName | undefined;
  /** Icon rendered after the label. */
  trailingIcon?: IconName | undefined;
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleProps {
  loading?: boolean | undefined;
  ref?: React.Ref<HTMLButtonElement> | undefined;
}

export interface ButtonLinkProps extends LinkProps, ButtonStyleProps {
  ref?: React.Ref<HTMLAnchorElement> | undefined;
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 16, md: 18, lg: 20 };

export const getButtonClassName = ({
  variant = "primary",
  size = "md",
  fullWidth = false,
  pill = false,
  loading = false,
  className = ""
}: ButtonStyleProps & { loading?: boolean; className?: string | undefined }): string =>
  [
    "btn",
    `btn-${variant}`,
    size !== "md" ? `btn-${size}` : "",
    fullWidth ? "btn-block" : "",
    pill ? "btn-pill" : "",
    loading ? "btn-loading" : "",
    className
  ]
    .filter(Boolean)
    .join(" ");

const ButtonContent: React.FC<{
  children: React.ReactNode;
  icon?: IconName | undefined;
  trailingIcon?: IconName | undefined;
  size: ButtonSize;
}> = ({ children, icon, trailingIcon, size }) => (
  <>
    {icon ? <Icon name={icon} size={ICON_SIZE[size]} className="btn-icon" /> : null}
    {children}
    {trailingIcon ? (
      <Icon name={trailingIcon} size={ICON_SIZE[size]} className="btn-icon btn-icon-trailing" />
    ) : null}
  </>
);

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  pill = false,
  icon,
  trailingIcon,
  className = "",
  disabled,
  type = "button",
  ref,
  ...props
}) => {
  const classes = getButtonClassName({ variant, size, fullWidth, pill, loading, className });

  return (
    <button
      aria-busy={loading || undefined}
      className={classes}
      disabled={disabled || loading}
      ref={ref}
      type={type}
      {...props}
    >
      {loading ? (
        <span className="btn-spinner-wrapper" aria-hidden="true">
          <span className="spinner"></span>
        </span>
      ) : null}
      <span className={`btn-label${loading ? " btn-text-hidden" : ""}`}>
        <ButtonContent icon={icon} size={size} trailingIcon={trailingIcon}>
          {children}
        </ButtonContent>
      </span>
    </button>
  );
};

export const ButtonLink: React.FC<ButtonLinkProps> = ({
  children,
  variant = "primary",
  size = "md",
  fullWidth = false,
  pill = false,
  icon,
  trailingIcon,
  className = "",
  ...props
}) => {
  const classes = getButtonClassName({ variant, size, fullWidth, pill, className });

  return (
    <Link className={classes} {...props}>
      <ButtonContent icon={icon} size={size} trailingIcon={trailingIcon}>
        {children}
      </ButtonContent>
    </Link>
  );
};
