import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Sheet } from "./Sheet";

const Harness: React.FC<{ onClose?: () => void; dismissible?: boolean }> = ({
  onClose = () => undefined,
  dismissible = true
}) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open sheet
      </button>
      <Sheet
        description="Pick what to add."
        dismissible={dismissible}
        footer={<button type="button">Save</button>}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        open={open}
        title="Add to shopping list"
      >
        <label>
          Quantity
          <input />
        </label>
      </Sheet>
    </>
  );
};

describe("Sheet", () => {
  it("portals a labelled modal dialog, locks scroll and restores focus on close", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open sheet" });
    opener.focus();

    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Add to shopping list" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Pick what to add.");
    expect(dialog.closest(".sheet-backdrop")?.parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe("hidden");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });

  it("closes on Escape and on a backdrop click", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    const backdrop = document.querySelector(".sheet-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("ignores Escape and backdrop clicks while not dismissible", () => {
    const onClose = vi.fn();
    render(<Harness dismissible={false} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".sheet-backdrop") as Element);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
