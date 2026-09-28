import React, { memo, useId, useRef } from "react";

import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";

import type { IconName } from "../../../components/Icon";

import "./LibraryShelf.css";

interface LibraryShelfProps {
  title: React.ReactNode;
  /** A short line under the title ("Your most-made dinners"). */
  subtitle?: React.ReactNode;
  icon?: IconName | undefined;
  /** "See all" style link on the right of the title row. */
  action?: { label: string; onClick: () => void; ariaLabel?: string | undefined } | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * A titled, horizontally scrolling row of compact recipe cards ("Cook again", "Quick weeknights").
 * Snap-scrolls on touch and bleeds to the screen edge on phones; pointer devices get arrows.
 */
const LibraryShelfComponent: React.FC<LibraryShelfProps> = ({
  title,
  subtitle,
  icon,
  action,
  children,
  className = ""
}) => {
  const titleId = useId();
  const trackRef = useRef<HTMLUListElement>(null);

  const scrollByPage = (direction: 1 | -1) => {
    const track = trackRef.current;

    if (!track) {
      return;
    }

    track.scrollBy({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: direction * Math.max(200, track.clientWidth * 0.85)
    });
  };

  return (
    <section aria-labelledby={titleId} className={["library-shelf", className].join(" ").trim()}>
      <div className="library-shelf-header">
        <div className="library-shelf-heading">
          <h2 className="library-shelf-title" id={titleId}>
            {icon ? (
              <span aria-hidden="true" className="library-shelf-icon">
                <Icon name={icon} size={15} strokeWidth={2.2} />
              </span>
            ) : null}
            <span>{title}</span>
          </h2>
          {subtitle ? <p className="library-shelf-subtitle">{subtitle}</p> : null}
        </div>
        <div className="library-shelf-tools">
          {action ? (
            <button
              aria-label={action.ariaLabel}
              className="library-shelf-action"
              onClick={action.onClick}
              type="button"
            >
              {action.label}
              <Icon name="chevron-right" size={16} />
            </button>
          ) : null}
          <span className="library-shelf-arrows">
            <IconButton
              aria-label="Scroll back"
              icon="chevron-left"
              onClick={() => scrollByPage(-1)}
              size="sm"
              variant="outline"
            />
            <IconButton
              aria-label="Scroll forward"
              icon="chevron-right"
              onClick={() => scrollByPage(1)}
              size="sm"
              variant="outline"
            />
          </span>
        </div>
      </div>
      <ul className="library-shelf-track" ref={trackRef}>
        {children}
      </ul>
    </section>
  );
};

export const LibraryShelf = memo(LibraryShelfComponent);
