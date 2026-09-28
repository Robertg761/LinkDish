import React, {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { preloadCommandPalette } from "../features/command-palette/CommandCenter";
import { useImportQueueBadge } from "../features/import-queue/use-import-queue-badge";
import { FirstRunOnboardingSheet } from "../features/onboarding/FirstRunOnboardingSheet";
import { requestCommandPalette } from "../lib/command-palette-events";
import { SAVE_FEEDBACK_EVENT } from "../lib/delight-events";
import { paletteShortcutLabel, RAIL_SHORTCUTS } from "../lib/shortcuts";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../lib/use-media-query";
import { lazyWithRetry } from "../platform/lazy";
import { useOnlineStatus } from "../platform/online-status";
import { OptionalChunkBoundary } from "../platform/OptionalChunkBoundary";

import { getAppRouteMeta } from "./app-route-meta";
import { BrandMark } from "./BrandMark";
import { Icon } from "./Icon";
import { usePageHidesTabBar } from "./tab-bar-visibility";

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

/** "3 imports waiting" (or "1 import needs a look") for the Add button's accessible name. */
const describeImportQueue = (pending: number, failed: number): string => {
  const parts: string[] = [];

  if (pending > 0) {
    parts.push(`${pending} import${pending === 1 ? "" : "s"} waiting`);
  }

  if (failed > 0) {
    parts.push(failed === 1 ? "1 import needs a look" : `${failed} imports need a look`);
  }

  return parts.join(", ");
};

/** The small count on the Add tab / rail button while links wait in the import queue. */
const ImportQueueCount: React.FC<{ count: number; attention: boolean }> = ({
  count,
  attention
}) => (
  <span
    aria-hidden="true"
    className={`app-nav-badge num${attention ? " is-attention" : ""}`}
    data-testid="import-queue-badge"
  >
    {count > 99 ? "99+" : count}
  </span>
);

/** How long "Back online" stays up after the connection returns. */
const BACK_ONLINE_MS = 3000;

/** Key caps shown on hover/focus of a rail destination ("G then C"). */
const RailShortcutHint: React.FC<{ keys: readonly string[] }> = ({ keys }) => (
  <span className="app-nav-shortcut" aria-hidden="true">
    {keys.map((key) => (
      <kbd key={key}>{key}</kbd>
    ))}
  </span>
);

/**
 * A slim bar while the browser is offline ("your recipes still work": the cookbook lives on the
 * device), then a brief "Back online".
 */
const OfflineBanner: React.FC = () => {
  const online = useOnlineStatus();
  const [showBackOnline, setShowBackOnline] = useState(false);
  const wasOfflineRef = useRef(!online);

  useEffect(() => {
    if (!online) {
      wasOfflineRef.current = true;
      setShowBackOnline(false);
      return;
    }

    if (!wasOfflineRef.current) {
      return;
    }

    wasOfflineRef.current = false;
    setShowBackOnline(true);
    const timer = window.setTimeout(() => setShowBackOnline(false), BACK_ONLINE_MS);
    return () => window.clearTimeout(timer);
  }, [online]);

  const visible = !online || showBackOnline;

  return (
    <div
      className={`app-offline-banner${visible ? " is-visible" : ""}${online ? " is-online" : ""}`}
      data-testid="offline-banner"
      role="status"
    >
      {visible ? (
        <p className="app-offline-banner-text">
          <Icon name={online ? "check-circle" : "wifi-off"} size={16} strokeWidth={2.2} />
          {online ? "Back online" : "You're offline — your recipes still work"}
        </p>
      ) : null}
    </div>
  );
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
  const shortcutLabel = paletteShortcutLabel();
  // The page a visit lands on appears as-is; entrance animations are for in-app navigation.
  const initialKeyRef = useRef(location.key);
  const isInitialView = location.key === initialKeyRef.current;
  // Phones get a bottom tab bar with a raised center Add button; from 1024px the same
  // nav becomes a side rail with Add as its primary button.
  const isRail = useMediaQuery(RAIL_MEDIA_QUERY);
  const addItem = NAV_ITEMS.find((item) => item.section === "add");
  const listItems = isRail ? NAV_ITEMS.filter((item) => item.section !== "add") : NAV_ITEMS;
  // Recipe detail pages (and an import result on screen) drop the phone tab bar; their action
  // bar and Back cover navigation.
  const pageHidesTabBar = usePageHidesTabBar();
  const hideTabBar = !isRail && (routeMeta.hideTabBar === true || pageHidesTabBar);
  const importQueue = useImportQueueBadge();
  const importQueueLabel = describeImportQueue(importQueue.pending, importQueue.failed);
  const addLabel = importQueueLabel ? `Add recipe (${importQueueLabel})` : "Add recipe";

  // Sheets, toasts and the timer dock are portaled outside the shell, so the inset they read
  // (--app-bottom-inset) is switched on the root element rather than on .app-shell.
  useLayoutEffect(() => {
    const root = document.documentElement;

    if (!hideTabBar) {
      return;
    }

    root.dataset.tabbar = "hidden";

    return () => {
      delete root.dataset.tabbar;
    };
  }, [hideTabBar]);

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
          aria-keyshortcuts={isRail ? RAIL_SHORTCUTS[item.to]?.aria : undefined}
          aria-label={isAdd ? addLabel : item.ariaLabel}
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
            {isAdd && importQueue.count > 0 ? (
              <ImportQueueCount attention={importQueue.failed > 0} count={importQueue.count} />
            ) : null}
          </span>
          <span className="app-nav-label">{item.label}</span>
          {isRail && RAIL_SHORTCUTS[item.to] ? (
            <RailShortcutHint keys={RAIL_SHORTCUTS[item.to]?.keys ?? []} />
          ) : null}
        </Link>
      </li>
    );
  };

  return (
    <div
      className={[
        "app-shell",
        isRail ? "app-shell-rail" : "app-shell-tabs",
        showTopBar ? "app-shell-has-topbar" : "",
        hideTabBar ? "app-shell-tabbar-hidden" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      {hideTabBar ? null : (
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
                  aria-keyshortcuts="N"
                  aria-label={addLabel}
                  className={`app-nav-add-button${routeMeta.section === "add" ? " is-active" : ""}`}
                  title="Add recipe (N)"
                  to={addItem.to}
                >
                  <Icon name="plus" size={20} strokeWidth={2.4} />
                  Add recipe
                  {importQueue.count > 0 ? (
                    <ImportQueueCount
                      attention={importQueue.failed > 0}
                      count={importQueue.count}
                    />
                  ) : null}
                </Link>
              ) : null}

              <button
                aria-keyshortcuts={shortcutLabel.startsWith("⌘") ? "Meta+K" : "Control+K"}
                className="app-nav-search"
                onClick={() => requestCommandPalette({ source: "rail_search" })}
                onFocus={preloadCommandPalette}
                onPointerEnter={preloadCommandPalette}
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
      )}

      <div className="app-main-column">
        <OfflineBanner />

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
            <div className="app-topbar-actions">
              <div className="app-topbar-page-actions" ref={setTopBarActionsTarget} />
              {!isRail ? (
                <button
                  aria-label="Search recipes and commands"
                  className="app-topbar-icon app-topbar-search"
                  onClick={() => requestCommandPalette({ source: "topbar_search" })}
                  onFocus={preloadCommandPalette}
                  onPointerDown={preloadCommandPalette}
                  type="button"
                >
                  <Icon name="search" size={21} />
                </button>
              ) : null}
            </div>
          </header>
        ) : null}

        <TopBarActionsContext.Provider value={showTopBar ? topBarActionsTarget : null}>
          <main
            className="app-shell-content"
            data-initial-view={isInitialView ? "" : undefined}
            id="main-content"
            tabIndex={-1}
          >
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
