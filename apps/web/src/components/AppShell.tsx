import React, { createContext, Suspense, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { FirstRunOnboardingSheet } from "../features/onboarding/FirstRunOnboardingSheet";
import { requestCommandPalette } from "../lib/command-palette-events";
import { SAVE_FEEDBACK_EVENT } from "../lib/delight-events";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../lib/use-media-query";
import { lazyWithRetry } from "../platform/lazy";
import { OptionalChunkBoundary } from "../platform/OptionalChunkBoundary";

import { getAppRouteMeta } from "./app-route-meta";
import { BrandMark } from "./BrandMark";
import { Icon } from "./Icon";

import type { AppSection } from "./app-route-meta";
import type { IconName } from "./Icon";

import "./AppShell.css";

interface AppShellProps {
  children?: React.ReactNode;
}

interface NavItem {
  section: AppSection;
  to: string;
  label: string;
  icon: IconName;
  /** Accessible name when it should differ from the visible label. */
  ariaLabel?: string;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  {
    section: "cookbook",
    to: "/",
    label: "Cookbook",
    icon: "book-open",
    ariaLabel: "Go to Cookbook"
  },
  { section: "plan", to: "/plan", label: "Plan", icon: "calendar-days" },
  { section: "add", to: "/import", label: "Add", icon: "plus", ariaLabel: "Add recipe" },
  { section: "shopping", to: "/shopping", label: "Shopping", icon: "shopping-basket" },
  {
    section: "you",
    to: "/account",
    label: "You",
    icon: "circle-user",
    ariaLabel: "You: household and account"
  }
];

const prefersReducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

const isMacLike = () => {
  try {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  } catch {
    return false;
  }
};

// Kitchen timers float above the tab bar on every page; the dock loads after first paint.
const TimerDock = lazyWithRetry(() =>
  import("../features/cook-mode/TimerDock").then((module) => ({ default: module.TimerDock }))
);

const TopBarActionsContext = createContext<HTMLElement | null>(null);

/**
 * Lets a page put actions (share, favorite, overflow menu) into the slim top app bar
 * on secondary routes. Renders nothing when there is no top bar on the current route.
 */
export const AppTopBarActions: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const target = useContext(TopBarActionsContext);

  return target ? createPortal(children, target) : null;
};

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const [cookbookBounceActive, setCookbookBounceActive] = useState(false);
  const [topBarActionsTarget, setTopBarActionsTarget] = useState<HTMLElement | null>(null);
  const [topBarScrolled, setTopBarScrolled] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const routeMeta = getAppRouteMeta(location.pathname);
  const showTopBar = !routeMeta.isDestination;
  const shortcutLabel = isMacLike() ? "⌘K" : "Ctrl K";
  // Phones get a bottom tab bar with a raised center Add button; from 1024px the same
  // nav becomes a side rail with Add as its primary button.
  const isRail = useMediaQuery(RAIL_MEDIA_QUERY);
  const addItem = NAV_ITEMS.find((item) => item.section === "add");
  const listItems = isRail ? NAV_ITEMS.filter((item) => item.section !== "add") : NAV_ITEMS;

  useEffect(() => {
    const handleSaveFeedback = () => {
      if (prefersReducedMotion()) {
        return;
      }

      setCookbookBounceActive(false);
      requestAnimationFrame(() => {
        setCookbookBounceActive(true);
      });
    };

    window.addEventListener(SAVE_FEEDBACK_EVENT, handleSaveFeedback);

    return () => {
      window.removeEventListener(SAVE_FEEDBACK_EVENT, handleSaveFeedback);
    };
  }, []);

  // The top bar starts transparent with no title (the page shows its own big title)
  // and turns into a glass bar with a compact title once the page scrolls.
  useEffect(() => {
    if (!showTopBar) {
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      setTopBarScrolled(window.scrollY > 40);
    };
    const handleScroll = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(update);
      }
    };

    update();
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);

      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [showTopBar, location.pathname]);

  // Only step back when the previous entry is inside LinkDish. On a deep link opened
  // in the same tab, history.length also counts other sites, so Back used to leave the app.
  const handleBack = () => {
    if (location.key !== "default") {
      void navigate(-1);
      return;
    }

    void navigate("/");
  };

  const renderNavItem = (item: NavItem) => {
    const active = routeMeta.section === item.section;
    const isAdd = item.section === "add";
    const isCookbook = item.section === "cookbook";

    return (
      <li className={`app-nav-item app-nav-item-${item.section}`} key={item.section}>
        <Link
          aria-current={active ? "page" : undefined}
          aria-label={item.ariaLabel}
          className={[
            "app-nav-link",
            isAdd ? "app-nav-link-add" : "",
            active ? "is-active" : "",
            isCookbook && cookbookBounceActive ? "app-nav-link-save-bounce" : ""
          ]
            .filter(Boolean)
            .join(" ")}
          onAnimationEnd={isCookbook ? () => setCookbookBounceActive(false) : undefined}
          to={item.to}
        >
          <span className="app-nav-icon" aria-hidden="true">
            <Icon name={item.icon} size={isAdd ? 26 : 22} strokeWidth={isAdd ? 2.4 : 2} />
          </span>
          <span className="app-nav-label">{item.label}</span>
        </Link>
      </li>
    );
  };

  return (
    <div
      className={[
        "app-shell",
        isRail ? "app-shell-rail" : "app-shell-tabs",
        showTopBar ? "app-shell-has-topbar" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <nav className={`app-nav ${isRail ? "app-nav-rail" : "app-nav-tabs"}`} aria-label="Primary">
        {isRail ? (
          <>
            <Link className="app-nav-brand" to="/" aria-label="LinkDish home">
              <span className="app-nav-brand-tile" aria-hidden="true">
                <BrandMark size={28} />
              </span>
              <span className="app-nav-brand-word">LinkDish</span>
            </Link>

            {addItem ? (
              <Link
                aria-current={routeMeta.section === "add" ? "page" : undefined}
                aria-label={addItem.ariaLabel}
                className={`app-nav-add-button${routeMeta.section === "add" ? " is-active" : ""}`}
                to={addItem.to}
              >
                <Icon name="plus" size={20} strokeWidth={2.4} />
                Add recipe
              </Link>
            ) : null}

            <button
              className="app-nav-search"
              onClick={() => requestCommandPalette({ source: "rail_search" })}
              type="button"
            >
              <Icon name="search" size={18} />
              <span className="app-nav-search-label">Search recipes</span>
              <kbd className="app-nav-search-kbd" aria-hidden="true">
                {shortcutLabel}
              </kbd>
            </button>
          </>
        ) : null}

        <ul className="app-nav-list">{listItems.map(renderNavItem)}</ul>

        {isRail ? (
          <div className="app-nav-footer">
            <Link
              aria-current={location.pathname === "/settings" ? "page" : undefined}
              className={`app-nav-footer-link${location.pathname === "/settings" ? " is-active" : ""}`}
              to="/settings"
            >
              <Icon name="settings" size={18} />
              Settings
            </Link>
            <Link
              aria-current={location.pathname === "/install" ? "page" : undefined}
              className={`app-nav-footer-link${location.pathname === "/install" ? " is-active" : ""}`}
              to="/install"
            >
              <Icon name="smartphone-download" size={18} />
              Install app
            </Link>
          </div>
        ) : null}
      </nav>

      <div className="app-main-column">
        {showTopBar ? (
          <header className={`app-topbar${topBarScrolled ? " is-scrolled" : ""}`}>
            <button
              aria-label="Go back"
              className="app-topbar-back"
              onClick={handleBack}
              type="button"
            >
              <Icon name="chevron-left" size={24} />
            </button>
            <p className="app-topbar-title">{routeMeta.title}</p>
            <div className="app-topbar-actions" ref={setTopBarActionsTarget} />
          </header>
        ) : null}

        <TopBarActionsContext.Provider value={showTopBar ? topBarActionsTarget : null}>
          <main className="app-shell-content" id="main-content" tabIndex={-1}>
            {children}
          </main>
        </TopBarActionsContext.Provider>
      </div>

      <OptionalChunkBoundary name="Timer dock">
        <Suspense fallback={null}>
          <TimerDock />
        </Suspense>
      </OptionalChunkBoundary>

      <FirstRunOnboardingSheet />
    </div>
  );
};
