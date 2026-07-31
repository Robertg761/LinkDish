import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell";

const LocationProbe = () => {
  const location = useLocation();

  return <span data-testid="current-path">{location.pathname}</span>;
};

const renderShell = (path: string) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <LocationProbe />
      </AppShell>
    </MemoryRouter>
  );
};

describe("AppShell destination navigation", () => {
  it.each(["/", "/import", "/shopping", "/account"])("hides the back button on %s", (path) => {
    renderShell(path);

    expect(screen.queryByRole("button", { name: "Go back" })).not.toBeInTheDocument();
  });

  it("keeps the back button on recipe detail pages and marks Cookbook active", () => {
    renderShell("/recipes/recipe_1");

    expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to Cookbook" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("routes between Cookbook, Add, Shopping, and Account from the destination bar", () => {
    renderShell("/");

    fireEvent.click(screen.getByRole("button", { name: "Add recipe" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/import");
    expect(screen.getByRole("button", { name: "Add recipe" })).toHaveAttribute(
      "aria-current",
      "page"
    );

    fireEvent.click(screen.getByRole("button", { name: "Shopping" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/shopping");
    expect(screen.getByRole("button", { name: "Shopping" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("button", { name: "Household and account" })).not.toHaveAttribute(
      "aria-current"
    );

    fireEvent.click(screen.getByRole("button", { name: "Household and account" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/account");
    expect(screen.getByRole("button", { name: "Household and account" })).toHaveAttribute(
      "aria-current",
      "page"
    );

    fireEvent.click(screen.getByRole("button", { name: "Go to Cookbook" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
  });
});
