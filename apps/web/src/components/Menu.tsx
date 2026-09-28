import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./Menu.css";

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  icon?: IconName | undefined;
  description?: string | undefined;
  tone?: "default" | "danger" | undefined;
  disabled?: boolean | undefined;
  /**
   * Makes the item a selectable option (role menuitemradio, or menuitemcheckbox with
   * `selection: "checkbox"`) and marks whether it is currently chosen with a check.
   */
  checked?: boolean | undefined;
  selection?: "radio" | "checkbox" | undefined;
}

export interface MenuSeparator {
  id: string;
  type: "separator";
}

export type MenuEntry = MenuItem | MenuSeparator;

export interface MenuTriggerProps {
  ref: (element: HTMLButtonElement | null) => void;
  id: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

interface MenuProps {
  items: ReadonlyArray<MenuEntry>;
  /** Render the trigger and spread the given props onto a button (e.g. IconButton). */
  renderTrigger: (props: MenuTriggerProps) => React.ReactNode;
  /** Accessible name for the menu; defaults to the trigger's name. */
  label?: string | undefined;
  /** Which trigger edge the menu lines up with. */
  align?: "start" | "end" | undefined;
  className?: string | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

const isSeparator = (entry: MenuEntry): entry is MenuSeparator =>
  "type" in entry && entry.type === "separator";

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;

/**
 * Overflow / popover menu. Portalled to <body> (z-index var(--z-popover)) so it is
 * never clipped, flips above the trigger when there is no room below, and supports
 * Arrow keys, Home/End, type-ahead, Escape and click-outside.
 */
export const Menu: React.FC<MenuProps> = ({
  items,
  renderTrigger,
  label,
  align = "end",
  className = "",
  onOpenChange
}) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; placement: string }>({
    top: -9999,
    left: -9999,
    placement: "bottom"
  });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpenRef = useRef<"first" | "last">("first");
  const triggerId = useId();
  const menuId = useId();

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  const getItemElements = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[role^='menuitem']:not([aria-disabled='true'])"
      ) ?? []
    );

  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      setOpenState(false);

      if (restoreFocus) {
        triggerRef.current?.focus();
      }
    },
    [setOpenState]
  );

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;

    if (!trigger || !menu) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const placeAbove =
      spaceBelow < menuHeight + TRIGGER_GAP + VIEWPORT_MARGIN && spaceAbove > spaceBelow;
    const top = placeAbove
      ? Math.max(VIEWPORT_MARGIN, triggerRect.top - menuHeight - TRIGGER_GAP)
      : Math.min(
          triggerRect.bottom + TRIGGER_GAP,
          Math.max(VIEWPORT_MARGIN, viewportHeight - menuHeight - VIEWPORT_MARGIN)
        );
    const preferredLeft = align === "end" ? triggerRect.right - menuWidth : triggerRect.left;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, preferredLeft),
      Math.max(VIEWPORT_MARGIN, viewportWidth - menuWidth - VIEWPORT_MARGIN)
    );

    setPosition({ top, left, placement: placeAbove ? "top" : "bottom" });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    updatePosition();
    const elements = getItemElements();
    const target = focusOnOpenRef.current === "last" ? elements[elements.length - 1] : elements[0];
    (target ?? menuRef.current)?.focus({ preventScroll: true });
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node | null;

      if (target && !menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        closeMenu(false);
      }
    };
    const handleViewportChange = () => updatePosition();

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeMenu, open, updatePosition]);

  const openMenu = (focus: "first" | "last") => {
    focusOnOpenRef.current = focus;
    setOpenState(true);
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const elements = getItemElements();
    const currentIndex = elements.findIndex((element) => element === document.activeElement);
    const focusAt = (index: number) => {
      const count = elements.length;

      if (count > 0) {
        elements[(index + count) % count]?.focus();
      }
    };

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(currentIndex + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusAt(currentIndex - 1);
        return;
      case "Home":
        event.preventDefault();
        focusAt(0);
        return;
      case "End":
        event.preventDefault();
        focusAt(elements.length - 1);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      case "Tab":
        event.preventDefault();
        closeMenu(true);
        return;
      default:
        break;
    }

    if (event.key.length === 1 && /\S/.test(event.key)) {
      const key = event.key.toLowerCase();
      const ordered = [...elements.slice(currentIndex + 1), ...elements.slice(0, currentIndex + 1)];
      ordered.find((element) => element.textContent?.trim().toLowerCase().startsWith(key))?.focus();
    }
  };

  const triggerProps: MenuTriggerProps = {
    ref: (element) => {
      triggerRef.current = element;
    },
    id: triggerId,
    onClick: () => {
      if (open) {
        closeMenu(false);
      } else {
        openMenu("first");
      }
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(event.key === "ArrowUp" ? "last" : "first");
      }
    },
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined
  };

  return (
    <>
      {renderTrigger(triggerProps)}
      {open
        ? createPortal(
            <div
              aria-label={label}
              aria-labelledby={label ? undefined : triggerId}
              className={["menu", className].filter(Boolean).join(" ")}
              data-placement={position.placement}
              id={menuId}
              onKeyDown={handleMenuKeyDown}
              ref={menuRef}
              role="menu"
              style={{ top: position.top, left: position.left }}
              tabIndex={-1}
            >
              {items.map((entry) =>
                isSeparator(entry) ? (
                  <div className="menu-separator" key={entry.id} role="separator" />
                ) : (
                  <button
                    aria-checked={entry.checked === undefined ? undefined : entry.checked}
                    aria-disabled={entry.disabled || undefined}
                    className={`menu-item${entry.tone === "danger" ? " menu-item-danger" : ""}${
                      entry.checked ? " is-checked" : ""
                    }`}
                    key={entry.id}
                    onClick={() => {
                      if (entry.disabled) {
                        return;
                      }

                      closeMenu(true);
                      entry.onSelect();
                    }}
                    role={
                      entry.checked === undefined
                        ? "menuitem"
                        : entry.selection === "checkbox"
                          ? "menuitemcheckbox"
                          : "menuitemradio"
                    }
                    tabIndex={-1}
                    type="button"
                  >
                    {entry.icon ? (
                      <Icon name={entry.icon} size={18} className="menu-item-icon" />
                    ) : null}
                    <span className="menu-item-copy">
                      <span className="menu-item-label">{entry.label}</span>
                      {entry.description ? (
                        <span className="menu-item-description">{entry.description}</span>
                      ) : null}
                    </span>
                    {entry.checked ? (
                      <Icon name="check" size={18} className="menu-item-check" />
                    ) : null}
                  </button>
                )
              )}
            </div>,
            document.body
          )
        : null}
    </>
  );
};
