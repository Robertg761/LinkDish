import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { IconButton } from "./IconButton";
import { Menu } from "./Menu";

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
