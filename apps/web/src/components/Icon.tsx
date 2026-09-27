import React from "react";

import { GOOGLE_GLYPH_PATHS, GOOGLE_GLYPH_VIEWBOX } from "./icons/google-glyph";
import { LUCIDE_ICON_NODES } from "./icons/lucide-icons";

import type { LucideIconName } from "./icons/lucide-icons";

import "./Icon.css";

export type IconName = LucideIconName | "google";

export interface IconProps {
  name: IconName;
  /** Rendered width and height in CSS pixels. */
  size?: number | undefined;
  /** Stroke color; defaults to the surrounding text color. */
  color?: string | undefined;
  className?: string | undefined;
  /**
   * Accessible name. Without it the icon is decorative (aria-hidden); give it a title
   * only when the icon carries meaning that no nearby text provides.
   */
  title?: string | undefined;
  strokeWidth?: number | undefined;
}

const renderGoogleGlyph = () =>
  GOOGLE_GLYPH_PATHS.map((path) =>
    React.createElement("path", { d: path.d, fill: path.fill, key: path.fill })
  );

/**
 * Inline SVG icon. Geometry is vendored from Lucide (ISC) so icons render with the
 * first paint, work offline and never depend on a third-party CDN.
 */
export const Icon: React.FC<IconProps> = ({
  name,
  size = 24,
  color,
  className = "",
  title,
  strokeWidth = 2
}) => {
  const isGoogle = name === "google";
  const children = isGoogle
    ? renderGoogleGlyph()
    : LUCIDE_ICON_NODES[name].map(([tag, attributes], index) =>
        React.createElement(tag, { ...attributes, key: index })
      );
  const accessibilityProps = title
    ? { role: "img", "aria-label": title }
    : { "aria-hidden": true as const };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={["icon", `icon-${name}`, className].filter(Boolean).join(" ")}
      data-icon={name}
      width={size}
      height={size}
      viewBox={isGoogle ? GOOGLE_GLYPH_VIEWBOX : "0 0 24 24"}
      fill="none"
      stroke={isGoogle ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      style={color ? { color } : undefined}
      {...accessibilityProps}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
};
