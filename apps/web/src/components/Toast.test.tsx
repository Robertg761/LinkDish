import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast } from "./Toast";

const Trigger: React.FC<{ onUndo?: () => void; count?: number }> = ({ onUndo, count = 1 }) => {
  const { showToast } = useToast();

  return (
    <button
      onClick={() => {
        for (let index = 0; index < count; index += 1) {
          showToast({
            message: `Removed recipe ${index + 1}`,
            ...(onUndo ? { action: { label: "Undo", onClick: onUndo } } : {})
          });
        }
      }}
      type="button"
    >
      Remove
    </button>
  );
};

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces a toast politely and auto-dismisses it", () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Removed recipe 1");

    act(() => {
      vi.advanceTimersByTime(4100);
    });

    expect(region).not.toHaveTextContent("Removed recipe 1");
  });

  it("runs the Undo action and closes the toast", () => {
    const onUndo = vi.fn();
    render(
      <ToastProvider>
        <Trigger onUndo={onUndo} />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Removed recipe 1")).not.toBeInTheDocument();
  });

  it("queues toasts beyond three until earlier ones are dismissed", () => {
    render(
      <ToastProvider>
        <Trigger count={4} />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.getByText("Removed recipe 3")).toBeInTheDocument();
    expect(screen.queryByText("Removed recipe 4")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0] as Element);

    expect(screen.getByText("Removed recipe 4")).toBeInTheDocument();
  });

  it("is a harmless no-op outside a provider", () => {
    render(<Trigger />);

    expect(() => fireEvent.click(screen.getByRole("button", { name: "Remove" }))).not.toThrow();
  });
});
