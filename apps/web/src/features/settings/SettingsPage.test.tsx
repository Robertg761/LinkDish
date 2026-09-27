import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getPreferences,
  PREFERENCES_STORAGE_KEY,
  resetPreferencesForTests
} from "../../preferences/preferences-store";

import { SettingsPage } from "./SettingsPage";

const renderPage = () =>
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>
  );

describe("SettingsPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPreferencesForTests();
    document.documentElement.removeAttribute("data-theme");
  });

  it("switches the theme and applies it to the document", () => {
    renderPage();

    const dark = screen.getByRole("radio", { name: "Dark" });
    fireEvent.click(dark);

    expect(dark).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}")).toMatchObject({
      theme: "dark"
    });
  });

  it("saves units, cooking and week preferences", () => {
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: "Metric" }));
    fireEvent.click(screen.getByRole("switch", { name: "Keep screen awake" }));
    fireEvent.click(screen.getByRole("radio", { name: "Largest" }));
    fireEvent.click(screen.getByRole("radio", { name: "Monday" }));

    expect(getPreferences()).toMatchObject({
      units: "metric",
      keepScreenAwake: false,
      cookTextSize: "xl",
      weekStartsOn: 1
    });
    expect(screen.getByText(/grams, millilitres/)).toBeInTheDocument();
  });

  it("links to install, support and privacy and leaves room for data tools", () => {
    renderPage();

    expect(screen.getByRole("link", { name: /install linkdish/i })).toHaveAttribute(
      "href",
      "/install"
    );
    expect(screen.getByRole("link", { name: /help & support/i })).toHaveAttribute(
      "href",
      "/support"
    );
    expect(screen.getByRole("link", { name: /privacy/i })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("region", { name: "Your data" })).toBeInTheDocument();
  });
});
