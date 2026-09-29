import React, { useEffect, useSyncExternalStore } from "react";

import { CORE_ICON_NODES, isCoreIconName } from "./icons/lucide-icons";

import type { ExtendedIconName, IconNode, LucideIconName } from "./icons/lucide-icons";
import type { ExtendedIconSet } from "./icons/lucide-icons-extended";

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

/** The Google glyph is drawn on an 18×18 grid (see ./icons/google-glyph.ts). */
const GOOGLE_VIEWBOX = "0 0 18 18";

/* ------------------------------------------------------------------------------------------------
 * The extended icon set
 *
 * Icons the shell and the Cookbook never show on their own live in a separate chunk, so the
 * landing page doesn't download them. It loads when the browser is idle after boot (main.tsx),
 * alongside every lazily loaded page or sheet (platform/lazy.ts), or when one of its icons first
 * renders. Until then such an icon is an empty SVG of the same size, so nothing shifts.
 * ---------------------------------------------------------------------------------------------- */

let extendedIcons: ExtendedIconSet | null = null;
let extendedIconsLoad: Promise<void> | null = null;
const extendedIconsListeners = new Set<() => void>();

/** Loads the extended icon set once; a failed load (offline) is tried again on the next call. */
export const loadExtendedIcons = (): Promise<void> => {
  extendedIconsLoad ??= import("./icons/lucide-icons-extended").then(
    (module) => {
      extendedIcons = module.EXTENDED_ICONS;
      extendedIconsListeners.forEach((listener) => {
        listener();
      });
    },
    (error: unknown) => {
      extendedIconsLoad = null;
      throw error;
    }
  );

  return extendedIconsLoad;
};

const subscribeExtendedIcons = (listener: () => void) => {
  extendedIconsListeners.add(listener);

  return () => {
    extendedIconsListeners.delete(listener);
  };
};

const getExtendedIcons = () => extendedIcons;

const renderNodes = (nodes: IconNode) =>
  nodes.map(([tag, attributes], index) => React.createElement(tag, { ...attributes, key: index }));

/** The drawing of an extended icon (or the Google glyph) once its chunk has loaded. */
const ExtendedGlyph: React.FC<{ name: ExtendedIconName | "google" }> = ({ name }) => {
  const icons = useSyncExternalStore(subscribeExtendedIcons, getExtendedIcons, getExtendedIcons);

  useEffect(() => {
    if (!icons) {
      loadExtendedIcons().catch(() => undefined);
    }
  }, [icons]);

  if (!icons) {
    return null;
  }

  if (name === "google") {
    return icons.google.map((path) =>
      React.createElement("path", { d: path.d, fill: path.fill, key: path.fill })
    );
  }

  return renderNodes(icons.nodes[name]);
};

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
      viewBox={isGoogle ? GOOGLE_VIEWBOX : "0 0 24 24"}
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
      {isCoreIconName(name) ? renderNodes(CORE_ICON_NODES[name]) : <ExtendedGlyph name={name} />}
    </svg>
  );
};
