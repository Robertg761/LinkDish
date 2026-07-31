import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { Button, ButtonLink } from "./Button";

type PreventableEvent = {
  preventDefault: () => void;
};

describe("Button", () => {
  it("does not submit forms unless type submit is requested", () => {
    const handleSubmit = vi.fn((event: PreventableEvent) => {
      event.preventDefault();
    });
    const handleBack = vi.fn();

    render(
      <form onSubmit={handleSubmit}>
        <Button onClick={handleBack}>Back</Button>
      </form>
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(handleBack).toHaveBeenCalledTimes(1);
    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it("preserves explicit submit buttons", () => {
    const handleSubmit = vi.fn((event: PreventableEvent) => {
      event.preventDefault();
    });

    render(
      <form onSubmit={handleSubmit}>
        <Button type="submit">Save</Button>
      </form>
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(handleSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders navigation buttons as links", () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/library">Back to Library</ButtonLink>
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "Back to Library" });

    expect(link).toHaveAttribute("href", "/library");
    expect(link).toHaveClass("btn", "btn-primary");
  });

  it("supports quiet outline variants", () => {
    render(
      <>
        <Button variant="outline">Manage</Button>
        <Button variant="outline-danger">Remove</Button>
      </>
    );

    expect(screen.getByRole("button", { name: "Manage" })).toHaveClass("btn-outline");
    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass("btn-outline-danger");
  });
});
