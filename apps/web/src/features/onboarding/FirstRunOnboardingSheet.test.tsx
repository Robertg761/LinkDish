import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { FirstRunOnboardingSheet } from "./FirstRunOnboardingSheet";

const LocationProbe = () => {
  const location = useLocation();

  return <span data-testid="current-path">{location.pathname}</span>;
};

const renderOnboarding = () =>
  render(
    <MemoryRouter initialEntries={["/import"]}>
      <LocationProbe />
      <FirstRunOnboardingSheet />
    </MemoryRouter>
  );

describe("FirstRunOnboardingSheet", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("sets the seen flag and lands on Cookbook when skipped", async () => {
    renderOnboarding();

    expect(await screen.findByRole("dialog", { name: "Save recipes from anywhere" }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(localStorage.getItem("linkdish:web:first-run-onboarding-seen:v1")).toBe("true");
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
  });

  it("uses progress dots and hides Skip on the final frame", async () => {
    const { container } = renderOnboarding();

    expect(await screen.findByRole("dialog", { name: "Save recipes from anywhere" }))
      .toBeInTheDocument();
    expect(screen.queryByText("1 / 3")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".first-run-progress-dot")).toHaveLength(3);
    expect(container.querySelectorAll(".first-run-progress-dot.is-active")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("dialog", { name: "Share the kitchen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start cooking" })).toBeInTheDocument();
  });

  it("does not show again after the localStorage flag is set", () => {
    localStorage.setItem("linkdish:web:first-run-onboarding-seen:v1", "true");

    renderOnboarding();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
