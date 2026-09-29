import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { MemoryRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { focusPageHeading, pageNameFromTitle } from "./route-focus";
import { ScrollManager } from "./ScrollManager";

const Nav: React.FC = () => {
  const navigate = useNavigate();

  return (
    <nav>
      <button onClick={() => void navigate("/plan")} type="button">
        Plan
      </button>
      <button onClick={() => void navigate("/slow")} type="button">
        Slow page
      </button>
      <button onClick={() => void navigate(-1)} type="button">
        Back
      </button>
    </nav>
  );
};

/** A page that shows the route fallback first, like a lazy page still loading. */
const SlowPage: React.FC = () => {
  const [ready, setReady] = useState(false);

  return ready ? (
    <h1>Slow page</h1>
  ) : (
    <div data-route-fallback="">
      <h1>Skeleton title</h1>
      <button onClick={() => setReady(true)} type="button">
        Finish loading
      </button>
    </div>
  );
};

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <ScrollManager />
      <Nav />
      <main id="main-content" tabIndex={-1}>
        <Routes>
          <Route element={<h1>Cookbook</h1>} path="/" />
          <Route element={<h1>This week</h1>} path="/plan" />
          <Route element={<SlowPage />} path="/slow" />
        </Routes>
      </main>
    </MemoryRouter>
  );

describe("route focus and announcements", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    document.title = "LinkDish";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("leaves focus alone on the first page of a visit", () => {
    renderApp();

    expect(document.body).toHaveFocus();
  });

  it("treats a redirect on arrival as the first page, not a navigation", () => {
    render(
      <MemoryRouter initialEntries={["/this-page-does-not-exist"]}>
        <ScrollManager />
        <main id="main-content" tabIndex={-1}>
          <Routes>
            <Route element={<h1>Cookbook</h1>} path="/" />
            <Route element={<Navigate replace to="/" />} path="*" />
          </Routes>
        </main>
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Cookbook" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cookbook" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("moves focus to the new page's main heading after navigating", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));

    const heading = screen.getByRole("heading", { name: "This week" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("route-announcer")).toBeEmptyDOMElement();
  });

  it("waits for a lazy page's own heading rather than its skeleton", async () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Slow page" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole("heading", { name: "Skeleton title" })).not.toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Finish loading" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Slow page" })).toHaveFocus());
  });

  it("announces the page after Back/Forward without moving focus", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "This week" })).toHaveFocus());

    document.title = "Cookbook · LinkDish";
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    fireEvent.click(back);

    await waitFor(() =>
      expect(screen.getByTestId("route-announcer")).toHaveTextContent("Cookbook")
    );
    expect(back).toHaveFocus();
  });
});

describe("focusPageHeading", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("falls back to <main> and reports it when no heading appears in time", () => {
    document.body.innerHTML = `<main id="main-content" tabindex="-1"><p>No heading</p></main>`;
    let time = 0;
    const frames: Array<() => void> = [];
    const onFallback = vi.fn();

    focusPageHeading({
      cancelFrame: () => undefined,
      now: () => time,
      onFallback,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      timeoutMs: 100
    });

    expect(onFallback).not.toHaveBeenCalled();
    time = 150;
    frames.shift()?.();

    expect(document.getElementById("main-content")).toHaveFocus();
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus from an open dialog", () => {
    document.body.innerHTML = `
      <main id="main-content" tabindex="-1"><h1>Plan</h1></main>
      <div aria-modal="true" role="dialog"><button>Inside</button></div>`;
    const inside = document.querySelector("button");
    inside?.focus();

    focusPageHeading();

    expect(inside).toHaveFocus();
  });

  it("names pages from the document title", () => {
    expect(pageNameFromTitle("Shopping list · LinkDish")).toBe("Shopping list");
    expect(pageNameFromTitle("LinkDish")).toBe("LinkDish");
    expect(pageNameFromTitle("")).toBe("LinkDish");
  });
});
