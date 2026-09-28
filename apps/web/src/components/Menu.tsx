import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "../lib/use-media-query";

import { Icon } from "./Icon";
import { useBodyScrollLock } from "./use-body-scroll-lock";

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
  /**
   * Starts a named group ("Share & print"): the items up to the next separator are wrapped in a
   * role="group" with this heading.
   */
  label?: string | undefined;
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

/**
 * - "popover" (default): anchored to the trigger on every screen.
 * - "adaptive": a bottom action sheet on touch phones (long menus stay in thumb reach and never
 *   scroll out of view), the anchored popover everywhere else.
 */
export type MenuPresentation = "popover" | "adaptive";

interface MenuProps {
  items: ReadonlyArray<MenuEntry>;
  /** Render the trigger and spread the given props onto a button (e.g. IconButton). */
  renderTrigger: (props: MenuTriggerProps) => React.ReactNode;
  /** Accessible name for the menu; defaults to the trigger's name. */
  label?: string | undefined;
  /** Which trigger edge the menu lines up with. */
  align?: "start" | "end" | undefined;
  presentation?: MenuPresentation | undefined;
  /** Heading shown at the top of the action sheet (e.g. the recipe's name). */
  sheetTitle?: React.ReactNode;
  className?: string | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

interface MenuGroup {
  id: string;
  label?: string | undefined;
  items: MenuItem[];
}

const isSeparator = (entry: MenuEntry): entry is MenuSeparator =>
  "type" in entry && entry.type === "separator";

/** Splits entries at separators; a labelled separator names the group that follows it. */
export const groupMenuEntries = (entries: ReadonlyArray<MenuEntry>): MenuGroup[] => {
  const groups: MenuGroup[] = [];
  let current: MenuGroup = { id: "menu-group-start", items: [] };

  for (const entry of entries) {
    if (isSeparator(entry)) {
      if (current.items.length > 0) {
        groups.push(current);
      }

      current = { id: entry.id, items: [], ...(entry.label ? { label: entry.label } : {}) };
      continue;
    }

    current.items.push(entry);
  }

  if (current.items.length > 0) {
    groups.push(current);
  }

  return groups;
};

/** Touch phones (portrait or a short landscape screen) get the action sheet. */
export const MENU_SHEET_MEDIA_QUERY =
  "(pointer: coarse) and (max-width: 767.98px), (pointer: coarse) and (max-height: 500px)";

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;
/** Below this there is no sensible room on either side, so the menu may cover its trigger. */
const MIN_POPOVER_HEIGHT = 160;

export interface PopoverPosition {
  top: number;
  left: number;
  placement: "top" | "bottom";
  maxHeight: number | undefined;
}

export interface PopoverLayoutInput {
  trigger: { top: number; bottom: number; left: number; right: number };
  menuWidth: number;
  /** The menu's full content height, whatever max-height currently applies. */
  naturalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * Height of the fixed bars along the bottom edge (the phone tab bar and its raised Add button,
   * plus the safe area) that the menu must not cover.
   */
  bottomInset: number;
  align: "start" | "end";
}

/**
 * Where an anchored menu goes: below its trigger when it fits, otherwise on whichever side has
 * more room, capped to that room so every item stays reachable. The bottom bars count as
 * off-screen, so a long menu flips up or scrolls instead of spilling over the tab bar.
 */
export const computePopoverPosition = ({
  trigger,
  menuWidth,
  naturalHeight,
  viewportWidth,
  viewportHeight,
  bottomInset,
  align
}: PopoverLayoutInput): PopoverPosition => {
  const insetFloor = viewportHeight - Math.max(0, bottomInset);
  // A very short screen (a landscape phone) keeps its whole height rather than no room at all.
  const floor =
    insetFloor >= MIN_POPOVER_HEIGHT + VIEWPORT_MARGIN * 2 ? insetFloor : viewportHeight;
  const spaceBelow = floor - trigger.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
  const spaceAbove = trigger.top - TRIGGER_GAP - VIEWPORT_MARGIN;
  const placeAbove = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
  const room = placeAbove ? spaceAbove : spaceBelow;
  const maxHeight = Math.min(floor - VIEWPORT_MARGIN * 2, Math.max(MIN_POPOVER_HEIGHT, room));
  const height = Math.min(naturalHeight, maxHeight);
  const preferredTop = placeAbove
    ? trigger.top - TRIGGER_GAP - height
    : trigger.bottom + TRIGGER_GAP;
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, preferredTop),
    Math.max(VIEWPORT_MARGIN, floor - height - VIEWPORT_MARGIN)
  );
  const preferredLeft = align === "end" ? trigger.right - menuWidth : trigger.left;
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, preferredLeft),
    Math.max(VIEWPORT_MARGIN, viewportWidth - menuWidth - VIEWPORT_MARGIN)
  );

  return {
    top,
    left,
    placement: placeAbove ? "top" : "bottom",
    maxHeight: naturalHeight > maxHeight ? maxHeight : undefined
  };
};

/**
 * The room the fixed bottom bars take: --app-bottom-inset (the tab bar plus the safe area; 0 on
 * desktop) and --app-fab-clearance (the raised Add button). They mix calc() and env(), so a probe
 * element resolves them.
 */
const readBottomInset = (): number => {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;bottom:0;left:0;width:0;visibility:hidden;pointer-events:none;" +
    "height:calc(var(--app-bottom-inset, 0px) + var(--app-fab-clearance, 0px))";
  document.body.appendChild(probe);
  const inset = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(inset) ? inset : 0;
};

type OpenedWith = "keyboard-first" | "keyboard-last" | "pointer";

/**
 * Overflow / popover menu. Portalled to <body> (z-index var(--z-popover)) so it is never
 * clipped: it opens on whichever side of the trigger has room and sizes itself to that room, so
 * no item is ever out of reach. Supports Arrow keys, Home/End, type-ahead, Escape and
 * click-outside. Opened by keyboard, focus lands on the first item; opened by a tap or click it
 * lands on the menu itself, so nothing looks pre-selected.
 */
export const Menu: React.FC<MenuProps> = ({
  items,
  renderTrigger,
  label,
  align = "end",
  presentation = "popover",
  sheetTitle,
  className = "",
  onOpenChange
}) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>({
    top: -9999,
    left: -9999,
    placement: "bottom",
    maxHeight: undefined
  });
  const [overflow, setOverflow] = useState<"none" | "top" | "bottom" | "both">("none");
  const isTouchPhone = useMediaQuery(MENU_SHEET_MEDIA_QUERY);
  const asSheet = presentation === "adaptive" && isTouchPhone;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openedWithRef = useRef<OpenedWith>("keyboard-first");
  const triggerId = useId();
  const menuId = useId();
  const groupIdPrefix = useId();
  const groups = groupMenuEntries(items);

  useBodyScrollLock(open && asSheet);

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

  const updateOverflow = useCallback(() => {
    const menu = menuRef.current;

    if (!menu) {
      return;
    }

    const hiddenAbove = menu.scrollTop > 1;
    const hiddenBelow = menu.scrollTop + menu.clientHeight < menu.scrollHeight - 1;
    setOverflow(
      hiddenAbove && hiddenBelow ? "both" : hiddenAbove ? "top" : hiddenBelow ? "bottom" : "none"
    );
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;

    if (!trigger || !menu || asSheet) {
      return;
    }

    setPosition(
      computePopoverPosition({
        align,
        bottomInset: readBottomInset(),
        menuWidth: menu.offsetWidth,
        // The full content height, whatever max-height currently applies.
        naturalHeight: menu.scrollHeight + (menu.offsetHeight - menu.clientHeight),
        trigger: trigger.getBoundingClientRect(),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      })
    );
  }, [align, asSheet]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    updatePosition();
    const elements = getItemElements();
    const opened = openedWithRef.current;
    const target =
      opened === "pointer"
        ? null
        : opened === "keyboard-last"
          ? elements[elements.length - 1]
          : elements[0];
    (target ?? menuRef.current)?.focus({ preventScroll: true });
  }, [open, updatePosition]);

  // Re-check the scroll cue once the final size is applied.
  useLayoutEffect(() => {
    if (open) {
      updateOverflow();
    }
  }, [open, position.maxHeight, asSheet, updateOverflow]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node | null;

      // The action sheet's backdrop covers the page and closes on click (closing on pointerdown
      // would let the same tap land on whatever was underneath).
      if (asSheet || !target || menuRef.current?.contains(target)) {
        return;
      }

      if (triggerRef.current?.contains(target)) {
        return;
      }

      closeMenu(false);
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
  }, [asSheet, closeMenu, open, updatePosition]);

  const openMenu = (openedWith: OpenedWith) => {
    openedWithRef.current = openedWith;
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
        focusAt(currentIndex < 0 ? elements.length - 1 : currentIndex - 1);
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
    onClick: (event) => {
      if (open) {
        closeMenu(false);
      } else {
        // detail is 0 for Enter/Space activation, the click count for a tap or mouse click.
        openMenu(event.detail > 0 ? "pointer" : "keyboard-first");
      }
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(event.key === "ArrowUp" ? "keyboard-last" : "keyboard-first");
      }
    },
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined
  };

  const renderItem = (entry: MenuItem) => (
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
      {entry.icon ? <Icon name={entry.icon} size={18} className="menu-item-icon" /> : null}
      <span className="menu-item-copy">
        <span className="menu-item-label">{entry.label}</span>
        {entry.description ? (
          <span className="menu-item-description">{entry.description}</span>
        ) : null}
      </span>
      {entry.checked ? <Icon name="check" size={18} className="menu-item-check" /> : null}
    </button>
  );

  const content = groups.map((group, index) => {
    const separator =
      index > 0 ? (
        <div className="menu-separator" key={`${group.id}-sep`} role="separator" />
      ) : null;

    if (!group.label) {
      return (
        <React.Fragment key={group.id}>
          {separator}
          {asSheet ? (
            <div className="menu-group" role="none">
              {group.items.map(renderItem)}
            </div>
          ) : (
            group.items.map(renderItem)
          )}
        </React.Fragment>
      );
    }

    const labelId = `${groupIdPrefix}-${index}`;

    return (
      <React.Fragment key={group.id}>
        {separator}
        <div aria-labelledby={labelId} className="menu-group" role="group">
          <div aria-hidden="true" className="menu-group-label" id={labelId}>
            {group.label}
          </div>
          {group.items.map(renderItem)}
        </div>
      </React.Fragment>
    );
  });

  const menuElement = (
    <div
      aria-label={label}
      aria-labelledby={label ? undefined : triggerId}
      className={["menu", asSheet ? "menu-in-sheet" : "", asSheet ? "" : className]
        .filter(Boolean)
        .join(" ")}
      data-overflow={overflow}
      data-placement={asSheet ? undefined : position.placement}
      id={menuId}
      onKeyDown={handleMenuKeyDown}
      onScroll={updateOverflow}
      ref={menuRef}
      role="menu"
      style={
        asSheet
          ? undefined
          : {
              top: position.top,
              left: position.left,
              ...(position.maxHeight ? { maxHeight: position.maxHeight } : {})
            }
      }
      tabIndex={-1}
    >
      {content}
    </div>
  );

  return (
    <>
      {renderTrigger(triggerProps)}
      {open
        ? createPortal(
            asSheet ? (
              <div
                className="menu-sheet-backdrop"
                onClick={(event) => {
                  if (event.target === event.currentTarget) {
                    closeMenu(true);
                  }
                }}
                role="presentation"
              >
                <div className={["menu-sheet", className].filter(Boolean).join(" ")}>
                  <span aria-hidden="true" className="menu-sheet-handle" />
                  {sheetTitle ? (
                    <p aria-hidden="true" className="menu-sheet-title">
                      {sheetTitle}
                    </p>
                  ) : null}
                  {menuElement}
                  <button
                    className="menu-sheet-cancel"
                    onClick={() => closeMenu(true)}
                    tabIndex={-1}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              menuElement
            ),
            document.body
          )
        : null}
    </>
  );
};
