import React from "react";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./Badge.css";

export type BadgeTone = "neutral" | "primary" | "tomato" | "butter" | "success" | "danger";

interface BadgeProps {
  children: React.ReactNode;
  tone?: BadgeTone | undefined;
  /** soft = tinted background (default); solid = filled. */
  appearance?: "soft" | "solid" | undefined;
  icon?: IconName | undefined;
  className?: string | undefined;
}

/** Small status label: "New", "Family", "Pro", counts. Use Chip for tags. */
export const Badge: React.FC<BadgeProps> = ({
  children,
  tone = "neutral",
  appearance = "soft",
  icon,
  className = ""
}) => (
  <span className={["badge", `badge-${tone}`, `badge-${appearance}`, className].join(" ").trim()}>
    {icon ? <Icon name={icon} size={12} strokeWidth={2.4} /> : null}
    {children}
  </span>
);
