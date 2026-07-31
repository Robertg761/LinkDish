import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "./ConfirmationDialog";

describe("ConfirmationDialog", () => {
  it("portals an accessible dialog and supports cancel, confirm, and Escape", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmationDialog
        cancelLabel="Keep item"
        confirmLabel="Remove"
        message="This cannot be undone."
        onCancel={onCancel}
        onConfirm={onConfirm}
        title="Remove item?"
        visible
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Remove item?" });
    expect(dialog.closest(".confirmation-dialog-backdrop")?.parentElement).toBe(document.body);
    expect(within(dialog).getByRole("button", { name: "Keep item" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <ConfirmationDialog
        cancelLabel="Keep item"
        confirmLabel="Remove"
        message="This cannot be undone."
        onCancel={onCancel}
        onConfirm={onConfirm}
        title="Remove item?"
        visible={false}
      />
    );
    expect(screen.queryByRole("dialog", { name: "Remove item?" })).not.toBeInTheDocument();
  });
});
