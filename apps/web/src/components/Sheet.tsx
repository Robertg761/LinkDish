import React, { useId, useRef } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";
import { useBodyScrollLock } from "./use-body-scroll-lock";
import { useModalFocusTrap } from "./use-modal-focus-trap";

import "./Sheet.css";

export type SheetSize = "sm" | "md" | "lg";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Heading text; also the dialog's accessible name. */
  title: React.ReactNode;
  /** Visually hide the heading (it still names the dialog). */
  hideTitle?: boolean | undefined;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Sticky action row at the bottom, e.g. Cancel / Save buttons. */
  footer?: React.ReactNode;
  /** Max width of the centered dialog on tablets and desktop. */
  size?: SheetSize | undefined;
  /** When false, Escape and backdrop clicks do not close (e.g. while saving). */
  dismissible?: boolean | undefined;
  /** Show the grab handle; dragging it down closes the sheet on phones. */
  showHandle?: boolean | undefined;
  /** Hide the close (×) button in the header. */
  hideCloseButton?: boolean | undefined;
  className?: string | undefined;
  /** Rendered as a data attribute for tests and analytics hooks. */
  testId?: string | undefined;
}

const DRAG_CLOSE_DISTANCE = 96;

/**
 * Modal surface: a bottom sheet on phones and a centered dialog from 768px. It
 * portals to <body>, traps focus, closes on Escape and backdrop click, locks body
 * scroll, and stacks above cook mode (z-index var(--z-sheet)).
 */
export const Sheet: React.FC<SheetProps> = ({
  open,
  onClose,
  title,
  hideTitle = false,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  showHandle = true,
  hideCloseButton = false,
  className = "",
  testId
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const dragStartRef = useRef<{ y: number; pointerId: number } | null>(null);
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: () => {
      if (dismissibleRef.current) {
        onClose();
      }
    }
  });
  useBodyScrollLock(open);

  if (!open) {
    return null;
  }

  const resetDrag = () => {
    dragStartRef.current = null;

    if (panelRef.current) {
      panelRef.current.style.translate = "";
      panelRef.current.classList.remove("is-dragging");
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dismissible) {
      return;
    }

    dragStartRef.current = { y: event.clientY, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    panelRef.current?.classList.add("is-dragging");
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;

    if (!start || start.pointerId !== event.pointerId || !panelRef.current) {
      return;
    }

    const distance = Math.max(0, event.clientY - start.y);
    // `translate` composes with the entrance animation's `transform`.
    panelRef.current.style.translate = `0 ${distance}px`;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;

    if (!start || start.pointerId !== event.pointerId) {
      return;
    }

    const distance = event.clientY - start.y;
    resetDrag();

    if (distance > DRAG_CLOSE_DISTANCE) {
      onClose();
    }
  };

  return createPortal(
    <div
      className="sheet-backdrop"
      data-testid={testId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) {
          onClose();
        }
      }}
      role="presentation"
    >
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={["sheet", `sheet-${size}`, className].filter(Boolean).join(" ")}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        {showHandle ? (
          <div
            aria-hidden="true"
            className="sheet-handle-zone"
            onPointerCancel={resetDrag}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <span className="sheet-handle" />
          </div>
        ) : null}
        <header className={`sheet-header${hideTitle ? " sheet-header-hidden-title" : ""}`}>
          <div className="sheet-heading">
            <h2 className={hideTitle ? "sr-only" : "sheet-title"} id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="sheet-description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          {hideCloseButton ? null : (
            <button
              aria-label="Close"
              className="sheet-close"
              disabled={!dismissible}
              onClick={onClose}
              type="button"
            >
              <Icon name="x" size={20} />
            </button>
          )}
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <footer className="sheet-footer">{footer}</footer> : null}
      </section>
    </div>,
    document.body
  );
};
