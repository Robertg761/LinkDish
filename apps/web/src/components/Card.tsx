import React from "react";
import "./Card.css";

export type CardVariant = "default" | "subtle" | "raised" | "outline" | "sunken";
export type CardPadding = "none" | "sm" | "md" | "lg";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: CardVariant | undefined;
  padding?: CardPadding | undefined;
  /** Adds a hover lift for cards that are clickable as a whole. */
  interactive?: boolean | undefined;
  ref?: React.Ref<HTMLDivElement> | undefined;
}

export const Card: React.FC<CardProps> = ({
  children,
  variant = "default",
  padding = "md",
  interactive = false,
  className = "",
  ref,
  ...props
}) => {
  return (
    <div
      className={[
        "card",
        `card-${variant}`,
        padding !== "md" ? `card-pad-${padding}` : "",
        interactive ? "card-interactive" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      ref={ref}
      {...props}
    >
      {children}
    </div>
  );
};
