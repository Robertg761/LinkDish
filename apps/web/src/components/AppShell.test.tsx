import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPEN_COMMAND_PALETTE_EVENT } from "../lib/command-palette-events";

import { AppShell, AppTopBarActions } from "./AppShell";
import { useHideTabBar } from "./tab-bar-visibility";

const importQueue = vi.hoisted(() => ({ count: 0, failed: 0, pending: 0 }));

vi.mock("../features/import-queue/use-import-queue-badge", () => ({
  useImportQueueBadge: () => ({ ...importQueue })
}));

const LocationProbe = () => {
  const location = useLocation();

  return <span data-testid="current-path">{location.pathname}</span>;
};

const renderShell = (path: string | string[], children: React.ReactNode = <LocationProbe />) => {
  const entries = Array.isArray(path) ? path : [path];

  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <AppShell>{children}</AppShell>
    </MemoryRouter>
  );
};

const mockMatchMedia = (matches: (query: string) => boolean) => {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
};

afterEach(() => {
  mockMatchMedia(() => false);
});

describe("AppShell destination navigation", () => {
  it.each(["/", "/plan", "/import", "/shopping", "/account"])(
    "hides the back button on %s",
    (path) => {
      renderShell(path);

      expect(screen.queryByRole("button", { name: "Go back" })).not.toBeInTheDocument();
    }
  );

  it.each(["/recipes/recipe_1", "/recipes/shared/abc", "/featured/banana-bread"])(
    "hides the phone tab bar on recipe detail page %s but keeps Back",
    (path) => {
      renderShell(path);

      expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
      expect(document.documentElement.dataset.tabbar).toBe("hidden");
    }
  );

  it("brings the tab bar back when leaving a recipe page", () => {
    const Leave = () => {
      const navigate = useNavigate();
      return (
        <button onClick={() => void navigate("/shopping")} type="button">
          Leave recipe
        </button>
      );
    };

    renderShell("/recipes/recipe_1", <Leave />);
    expect(document.documentElement.dataset.tabbar).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Leave recipe" }));

    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass("app-nav-tabs");
    expect(document.documentElement.dataset.tabbar).toBeUndefined();
  });

  it("keeps the tab bar on other secondary pages such as settings", () => {
    renderShell("/settings");

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(document.documentElement.dataset.tabbar).toBeUndefined();
  });

  it("renders the primary nav as links in a bottom tab bar on phones", () => {
    renderShell("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });

    expect(nav).toHaveClass("app-nav-tabs");
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toEqual(["/", "/plan", "/import", "/shopping", "/account"]);
  });

  it("routes between Cookbook, Plan, Add, Shopping, and You from the tab bar", () => {
    renderShell("/");

    fireEvent.click(screen.getByRole("link", { name: "Add recipe" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/import");
    expect(screen.getByRole("link", { name: "Add recipe" })).toHaveAttribute(
      "aria-current",
      "page"
    );

    fireEvent.click(screen.getByRole("link", { name: "Plan" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/plan");

    fireEvent.click(screen.getByRole("link", { name: "Shopping" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/shopping");
    expect(screen.getByRole("link", { name: "Shopping" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /household and account/i })).not.toHaveAttribute(
      "aria-current"
    );

    fireEvent.click(screen.getByRole("link", { name: /household and account/i }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/account");
    expect(screen.getByRole("link", { name: /household and account/i })).toHaveAttribute(
      "aria-current",
      "page"
    );

    fireEvent.click(screen.getByRole("link", { name: "Go to Cookbook" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
  });

  it("goes back inside the app when there is in-app history", () => {
    const Navigator = () => {
      const navigate = useNavigate();

      return (
        <button onClick={() => void navigate("/recipes/recipe_1")} type="button">
          Open recipe
        </button>
      );
    };

    render(
      <MemoryRouter initialEntries={["/shopping"]}>
        <AppShell>
          <Routes>
            <Route path="*" element={<Navigator />} />
          </Routes>
          <LocationProbe />
        </AppShell>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open recipe" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/recipes/recipe_1");

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/shopping");
  });

  it("goes to the Cookbook instead of leaving the app on a direct deep link", () => {
    renderShell("/recipes/shared/abc");

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.getByTestId("current-path")).toHaveTextContent(/^\/$/);
  });

  it("shows a skip link to the main content", () => {
    renderShell("/");

    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content"
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("portals page actions into the top bar on secondary routes", () => {
    renderShell(
      "/recipes/recipe_1",
      <AppTopBarActions>
        <button type="button">Share recipe</button>
      </AppTopBarActions>
    );

    const action = screen.getByRole("button", { name: "Share recipe" });

    expect(action.closest(".app-topbar")).not.toBeNull();
  });
});

describe("AppShell side rail", () => {
  it("switches to a rail with an Add recipe button, search and footer links on desktop", () => {
    mockMatchMedia((query) => query.includes("min-width: 1024px"));
    const onOpenPalette = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenPalette);

    renderShell("/settings");

    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass("app-nav-rail");
    expect(screen.getByRole("link", { name: "Add recipe" })).toHaveAttribute("href", "/import");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Install app" })).toHaveAttribute("href", "/install");

    fireEvent.click(screen.getByRole("button", { name: /search recipes/i }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);

    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenPalette);
  });

  it("keeps the rail on recipe detail pages and marks Cookbook active", () => {
    mockMatchMedia((query) => query.includes("min-width: 1024px"));

    renderShell("/recipes/recipe_1");

    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass("app-nav-rail");
    expect(screen.getByRole("link", { name: "Go to Cookbook" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(document.documentElement.dataset.tabbar).toBeUndefined();
  });
});

describe("AppShell search, shortcuts and status", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("puts a search button in the phone top bar on secondary routes", () => {
    const onOpenPalette = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenPalette);

    renderShell("/recipes/recipe_1");
    fireEvent.click(screen.getByRole("button", { name: "Search recipes and commands" }));

    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    expect((onOpenPalette.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      source: "topbar_search"
    });
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenPalette);
  });

  it("keeps destination pages free of the top bar search", () => {
    renderShell("/");

    expect(
      screen.queryByRole("button", { name: "Search recipes and commands" })
    ).not.toBeInTheDocument();
  });

  it("advertises keyboard shortcuts on the rail", () => {
    mockMatchMedia((query) => query.includes("min-width: 1024px"));
    renderShell("/");

    expect(screen.getByRole("link", { name: "Plan" })).toHaveAttribute("aria-keyshortcuts", "G P");
    expect(screen.getByRole("link", { name: "Shopping" })).toHaveAttribute(
      "aria-keyshortcuts",
      "G S"
    );
    expect(screen.getByRole("link", { name: "Go to Cookbook" })).toHaveAttribute(
      "aria-keyshortcuts",
      "G C"
    );
    expect(screen.getByRole("link", { name: "Add recipe" })).toHaveAttribute(
      "aria-keyshortcuts",
      "N"
    );
    expect(screen.getByRole("button", { name: /search recipes/i })).toHaveAttribute(
      "aria-keyshortcuts",
      expect.stringMatching(/^(Meta|Control)\+K$/)
    );
    expect(
      screen.queryByRole("button", { name: "Search recipes and commands" })
    ).not.toBeInTheDocument();
  });

  it("shows a slim offline banner, then a brief back-online note", () => {
    vi.useFakeTimers();
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    renderShell("/");
    const banner = screen.getByTestId("offline-banner");

    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toBeEmptyDOMElement();

    onLine.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(banner).toHaveTextContent("You're offline — your recipes still work");

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(banner).toHaveTextContent("Back online");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(banner).toBeEmptyDOMElement();
  });

  it("skips the entrance animation for the page a visit lands on", () => {
    renderShell("/");
    const main = screen.getByRole("main");

    expect(main).toHaveAttribute("data-initial-view");

    fireEvent.click(screen.getByRole("link", { name: "Plan" }));
    expect(main).not.toHaveAttribute("data-initial-view");
  });

  it("lets a page hide the phone tab bar while its own action bar is on screen", () => {
    const ImportResult = () => {
      useHideTabBar();
      return <p>Result</p>;
    };
    const ImportPage = () => {
      const [showResult, setShowResult] = React.useState(true);

      return (
        <>
          {showResult ? <ImportResult /> : null}
          <button onClick={() => setShowResult(false)} type="button">
            Import another
          </button>
        </>
      );
    };

    renderShell("/import", <ImportPage />);

    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(document.documentElement.dataset.tabbar).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Import another" }));

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(document.documentElement.dataset.tabbar).toBeUndefined();
  });

  it("counts links waiting in the import queue on the Add tab and the rail button", async () => {
    Object.assign(importQueue, { count: 3, failed: 1, pending: 2 });

    try {
      renderShell("/");
      // The count loads beside the page (it reads IndexedDB), then names itself on the link.
      const add = await screen.findByRole("link", {
        name: "Add recipe (2 imports waiting, 1 import needs a look)"
      });
      const badge = await within(add).findByTestId("import-queue-badge");
      expect(badge).toHaveTextContent("3");
      expect(badge).toHaveClass("is-attention");
    } finally {
      Object.assign(importQueue, { count: 0, failed: 0, pending: 0 });
    }
  });

  it("shows no count while the import queue is empty", async () => {
    renderShell("/");
    await act(async () => {
      await import("./ImportQueueCount");
    });

    expect(screen.getByRole("link", { name: "Add recipe" })).toBeInTheDocument();
    expect(screen.queryByTestId("import-queue-badge")).not.toBeInTheDocument();
  });
});
