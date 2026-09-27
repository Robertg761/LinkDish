import { render, screen, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import {
  PREFERENCES_STORAGE_KEY,
  resetPreferencesForTests
} from "../../preferences/preferences-store";

import { PlanPage } from "./PlanPage";

describe("PlanPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPreferencesForTests();
  });

  it("shows the editorial header, a seven-day week and a way back to the Cookbook", () => {
    render(
      <MemoryRouter>
        <PlanPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("This week");
    expect(
      within(screen.getByRole("list", { name: "This week" })).getAllByRole("listitem")
    ).toHaveLength(7);
    expect(screen.getByRole("link", { name: /browse your cookbook/i })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("starts the week on the preferred day", () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ weekStartsOn: 1 }));
    resetPreferencesForTests();

    render(
      <MemoryRouter>
        <PlanPage />
      </MemoryRouter>
    );

    const firstDay = within(screen.getByRole("list", { name: "This week" })).getAllByRole(
      "listitem"
    )[0];
    const monday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      new Date(2026, 8, 28)
    );

    expect(firstDay).toHaveTextContent(monday);
  });
});
