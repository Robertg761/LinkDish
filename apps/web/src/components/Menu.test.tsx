import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { IconButton } from "./IconButton";
import { computePopoverPosition, Menu, MENU_SHEET_MEDIA_QUERY } from "./Menu";

import type { PopoverLayoutInput } from "./Menu";

// A 390×844 phone with a 64px tab bar plus the 24px raised Add button along the bottom.
const phoneLayout = (overrides: Partial<PopoverLayoutInput> = {}): PopoverLayoutInput => ({
  align: "end",
  bottomInset: 88,
  menuWidth: 240,
  naturalHeight: 400,
  trigger: { bottom: 330, left: 250, right: 374, top: 294 },
  viewportHeight: 844,
  viewportWidth: 390,
  ...overrides
});

describe("computePopoverPosition", () => {
  it("opens below the trigger when the menu fits above the tab bar", () => {
    const position = computePopoverPosition(phoneLayout({ naturalHeight: 300 }));

    expect(position).toEqual({ left: 134, maxHeight: undefined, placement: "bottom", top: 336 });
  });

  it("flips up rather than spilling over the tab bar", () => {
    // 360px would fit before the screen's bottom edge (844) but not above the tab bar (756).
    const layout = phoneLayout({
      naturalHeight: 360,
      trigger: { bottom: 420, left: 250, right: 374, top: 384 }
    });

    expect(computePopoverPosition({ ...layout, bottomInset: 0 }).placement).toBe("bottom");

    const position = computePopoverPosition(layout);
    expect(position.placement).toBe("top");
    expect(position.maxHeight).toBeUndefined();
    expect(position.top + 360).toBeLessThanOrEqual(384);
  });

  it("caps a long menu to the room above the tab bar and scrolls the rest", () => {
    const position = computePopoverPosition(
      phoneLayout({ naturalHeight: 600, trigger: { bottom: 176, left: 250, right: 374, top: 140 } })
    );

    expect(position.placement).toBe("bottom");
    expect(position.maxHeight).toBe(844 - 88 - 176 - 6 - 8);
    expect(position.top + (position.maxHeight ?? 0)).toBeLessThanOrEqual(844 - 88 - 8);
  });

  it("keeps the full height on a screen too short to spare the inset", () => {
    const position = computePopoverPosition(
      phoneLayout({
        naturalHeight: 150,
        trigger: { bottom: 40, left: 250, right: 374, top: 4 },
        viewportHeight: 240
      })
    );

    expect(position.placement).toBe("bottom");
    expect(position.maxHeight).toBeUndefined();
  });
});

const renderMenu = (onEdit = vi.fn(), onDelete = vi.fn()) =>
  render(
    <Menu
      items={[
        { id: "edit", label: "Edit", icon: "pencil", onSelect: onEdit },
        { id: "archive", label: "Archive", disabled: true, onSelect: vi.fn() },
        { id: "sep", type: "separator" },
        { id: "delete", label: "Delete", icon: "trash", tone: "danger", onSelect: onDelete }
      ]}
      label="Recipe actions"
      renderTrigger={(props) => (
        <IconButton aria-label="More actions" icon="more-horizontal" {...props} />
      )}
    />
  );

describe("Menu", () => {
  it("opens from its trigger, focuses the first item and runs the chosen action", () => {
    const onEdit = vi.fn();
    renderMenu(onEdit);
    const trigger = screen.getByRole("button", { name: "More actions" });

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: "Recipe actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();

    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("moves with the arrow keys, skips disabled items and closes on Escape", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "More actions" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside", () => {
    renderMenu();

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opened by a tap or click, focuses the menu itself so no option looks pre-selected", () => {
    renderMenu();

    fireEvent.click(screen.getByRole("button", { name: "More actions" }), { detail: 1 });

    const menu = screen.getByRole("menu", { name: "Recipe actions" });
    expect(menu).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Edit" })).not.toHaveFocus();

    // Arrow keys still start from the top.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
  });

  it("names groups from labelled separators", () => {
    render(
      <Menu
        items={[
          { id: "g-share", label: "Share & print", type: "separator" },
          { id: "share", label: "Share", onSelect: vi.fn() },
          { id: "print", label: "Print", onSelect: vi.fn() },
          { id: "sep", type: "separator" },
          { id: "delete", label: "Delete", onSelect: vi.fn(), tone: "danger" }
        ]}
        label="Recipe actions"
        renderTrigger={(props) => (
          <IconButton aria-label="More actions" icon="more-horizontal" {...props} />
        )}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));

    const group = screen.getByRole("group", { name: "Share & print" });
    expect(
      within(group)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
    ).toEqual(["Share", "Print"]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("becomes a bottom action sheet on touch phones when adaptive", () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === MENU_SHEET_MEDIA_QUERY,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));

    try {
      const onDelete = vi.fn();
      render(
        <Menu
          items={[
            { id: "edit", label: "Edit", onSelect: vi.fn() },
            { id: "sep", type: "separator" },
            { id: "delete", label: "Delete", onSelect: onDelete, tone: "danger" }
          ]}
          label="Recipe actions"
          presentation="adaptive"
          renderTrigger={(props) => (
            <IconButton aria-label="More actions" icon="more-horizontal" {...props} />
          )}
          sheetTitle="Banana Bread"
        />
      );

      const trigger = screen.getByRole("button", { name: "More actions" });
      fireEvent.click(trigger, { detail: 1 });

      const menu = screen.getByRole("menu", { name: "Recipe actions" });
      expect(menu).toHaveClass("menu-in-sheet");
      expect(menu.closest(".menu-sheet")).toHaveTextContent("Banana Bread");

      // A tap on the backdrop's own area (not a pointerdown) closes it.
      fireEvent.pointerDown(document.body);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();

      fireEvent.click(trigger, { detail: 1 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(onDelete).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }));
    }
  });

  it("renders selectable options as checked radio and checkbox items", () => {
    const onSelect = vi.fn();
    render(
      <Menu
        items={[
          { id: "recent", label: "Recently added", checked: true, onSelect },
          { id: "az", label: "A–Z", checked: false, onSelect },
          { id: "sep", type: "separator" },
          { id: "reverse", label: "Reverse order", checked: false, selection: "checkbox", onSelect }
        ]}
        label="Sort"
        renderTrigger={(props) => <IconButton aria-label="Sort" icon="sort" {...props} />}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sort" }));

    expect(screen.getByRole("menuitemradio", { name: "Recently added" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.getByRole("menuitemradio", { name: "Recently added" })).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: "A–Z" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Reverse order" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
