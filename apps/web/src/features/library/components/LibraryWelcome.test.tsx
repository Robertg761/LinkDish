import { render, screen, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { LibraryWelcome } from "./LibraryWelcome";

describe("LibraryWelcome", () => {
  it("shows the welcome at once and fills the sample shelf's placeholder cards when the samples arrive", async () => {
    const { container } = render(
      <MemoryRouter>
        <LibraryWelcome variant="starter" />
      </MemoryRouter>
    );

    // The welcome never waits for the samples.
    expect(screen.getByRole("heading", { name: "Paste a link. Get cooking." })).toBeInTheDocument();
    expect(screen.getByText("Welcome to LinkDish")).toBeInTheDocument();

    // Until then, card-shaped placeholders (hidden from assistive tech) hold the shelf's place.
    const shelf = screen.getByRole("region", { name: "Try a sample" });
    const placeholders = container.querySelectorAll(".library-welcome-sample-placeholder");
    expect(placeholders.length).toBeGreaterThan(0);
    placeholders.forEach((placeholder) => {
      expect(placeholder.closest("li")).toHaveAttribute("aria-hidden", "true");
    });
    expect(within(shelf).queryAllByRole("link")).toHaveLength(0);

    expect(await within(shelf).findByRole("link", { name: "Pizza Crust" })).toHaveAttribute(
      "href",
      "/featured/pizza-crust"
    );
    expect(container.querySelector(".library-welcome-sample-placeholder")).toBeNull();
  });

  it("shows the samples straight away once they have been on screen", () => {
    // (The first test loaded and showed them.)
    render(
      <MemoryRouter>
        <LibraryWelcome variant="empty" />
      </MemoryRouter>
    );

    const shelf = screen.getByRole("region", { name: "Try a sample" });
    expect(within(shelf).getByRole("link", { name: "Pizza Crust" })).toBeInTheDocument();
    expect(screen.getByText("Your cookbook is ready")).toBeInTheDocument();
  });
});
