import React from "react";
import { Link, type LinkProps } from "react-router-dom";
import "./Button.css";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "outline-danger";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  fullWidth?: boolean;
}

interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

const getButtonClasses = (
  variant: ButtonVariant,
  fullWidth: boolean,
  className: string,
  loading = false
) =>
  ["btn", `btn-${variant}`, fullWidth ? "btn-block" : "", loading ? "btn-loading" : "", className]
    .filter(Boolean)
    .join(" ");

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = "primary",
  loading = false,
  fullWidth = false,
  className = "",
  disabled,
  type = "button",
  ...props
}) => {
  const classes = getButtonClasses(variant, fullWidth, className, loading);

  return (
    <button className={classes} disabled={disabled || loading} type={type} {...props}>
      {loading ? (
        <span className="btn-spinner-wrapper" aria-hidden="true">
          <span className="spinner"></span>
        </span>
      ) : null}
      <span className={loading ? "btn-text-hidden" : ""}>{children}</span>
    </button>
  );
};

export const ButtonLink: React.FC<ButtonLinkProps> = ({
  children,
  variant = "primary",
  fullWidth = false,
  className = "",
  ...props
}) => {
  const classes = getButtonClasses(variant, fullWidth, className);

  return (
    <Link className={classes} {...props}>
      {children}
    </Link>
  );
};
