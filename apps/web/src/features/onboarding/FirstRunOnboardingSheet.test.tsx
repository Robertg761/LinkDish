import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { FirstRunOnboardingSheet } from "./FirstRunOnboardingSheet";
import { isOnboardingSuppressedRoute, ONBOARDING_STORAGE_KEY } from "./onboarding-routes";

const LocationProbe = () => {
  const location = useLocation();

  return <span data-testid="current-path">{`${location.pathname}${location.search}`}</span>;
};

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <FirstRunOnboardingSheet />
    </MemoryRouter>
  );

const findSheet = (name: string) => screen.findByRole("dialog", { name }, { timeout: 3000 });

/** Long enough for the sheet's show delay and its lazy chunk. */
const waitPastShowDelay = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });

describe("isOnboardingSuppressedRoute", () => {
  it.each([
    ["/import", "?url=https%3A%2F%2Fx.com"],
    ["/import", "?text=hello"],
    ["/featured/pizza-crust", ""],
    ["/recipes/shared/abc", ""],
    ["/household", "?invite=CODE1234"],
    ["/account", "?invite=CODE1234"],
    ["/account", "?upgrade=plus"],
    ["/pricing", ""],
    ["/pricing", "?checkout=success"],
    ["/sso-callback", ""],
    ["/privacy", ""],
    ["/support", ""],
    ["/install", ""]
  ])("never covers the deep link %s%s", (pathname, search) => {
    expect(isOnboardingSuppressedRoute(pathname, search)).toBe(true);
  });

  it.each([
    ["/", ""],
    ["/import", ""],
    ["/plan", ""],
    ["/shopping", ""],
    ["/account", ""],
    ["/household", ""]
  ])("may welcome a plain visit to %s%s", (pathname, search) => {
    expect(isOnboardingSuppressedRoute(pathname, search)).toBe(false);
  });
});

describe("FirstRunOnboardingSheet", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("welcomes a first visit and closes without navigating anywhere", async () => {
    renderAt("/plan");

    expect(await findSheet("Save recipes from anywhere")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
    expect(screen.getByTestId("current-path")).toHaveTextContent("/plan");
  });

  it("opens on its own without a focus ring on a close button", async () => {
    renderAt("/");

    const dialog = await findSheet("Save recipes from anywhere");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("closes on Escape like every sheet", async () => {
    renderAt("/");

    const dialog = await findSheet("Save recipes from anywhere");
    // The focus trap (and its Escape handling) is live once focus has moved into the sheet.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
    expect(screen.getByTestId("current-path")).toHaveTextContent(/^\/$/u);
  });

  it.each([
    "/import?url=https%3A%2F%2Fexample.com%2Fr",
    "/featured/pizza-crust",
    "/household?invite=AB12CD34"
  ])("stays out of the way of the deep link %s", async (path) => {
    renderAt(path);
    await waitPastShowDelay();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-path")).toHaveTextContent(path);
    // Not marked as seen: a later plain visit still gets the welcome.
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it("does not show again once seen", async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    renderAt("/");
    await waitPastShowDelay();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("walks through three frames with progress dots and ends on a sample recipe", async () => {
    renderAt("/");

    await findSheet("Save recipes from anywhere");
    expect(document.body.querySelectorAll(".first-run-progress-dot")).toHaveLength(3);
    expect(document.body.querySelectorAll(".first-run-progress-dot.is-active")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await findSheet("Cook calmly, shop smarter")).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Next" });
    next.focus();
    fireEvent.click(next);
    expect(await findSheet("Start with one recipe")).toBeInTheDocument();
    // Next leaves the footer on the last frame; focus lands on the new frame's title, and the
    // way out keeps its name.
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.getByText("Start with one recipe", { selector: "p" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Try a sample recipe/u }));

    await waitFor(() => {
      expect(screen.getByTestId("current-path")).toHaveTextContent(
        "/featured/classic-chocolate-chip-cookies"
      );
    });
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
  });

  it("imports a pasted link from the last frame", async () => {
    renderAt("/");

    await findSheet("Save recipes from anywhere");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await findSheet("Start with one recipe");

    fireEvent.change(screen.getByRole("textbox", { name: "Recipe link" }), {
      target: { value: "www.seriouseats.com/chili" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Get the recipe" }));

    await waitFor(() => {
      expect(screen.getByTestId("current-path")).toHaveTextContent(
        `/import?url=${encodeURIComponent("https://www.seriouseats.com/chili")}`
      );
    });
  });
});
