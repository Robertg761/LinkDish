import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";

import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";

import { useTimerDockHost } from "./timer-dock-host";
import {
  addKitchenTimerTime,
  dismissKitchenTimer,
  formatTimerClock,
  getTimerContextLabel,
  getTimerRemainingMs,
  hydrateKitchenTimers,
  isTimerDone,
  pauseKitchenTimer,
  resumeKitchenTimer,
  useKitchenTimers
} from "./timer-store";

import type { KitchenTimer } from "./timer-store";

import "./TimerDock.css";

export { formatTimerClock };

/**
 * Dock order: finished timers first (they are ringing), then running ones soonest first, then
 * paused ones. The first is the one the collapsed dock shows.
 */
export const sortTimersForDock = (timers: readonly KitchenTimer[], now: number): KitchenTimer[] => {
  const rank = (timer: KitchenTimer) => (isTimerDone(timer, now) ? 0 : timer.paused ? 2 : 1);

  return [...timers].sort((left, right) => {
    const byRank = rank(left) - rank(right);

    if (byRank !== 0) {
      return byRank;
    }

    if (rank(left) === 0) {
      return (left.doneAt ?? 0) - (right.doneAt ?? 0);
    }

    return getTimerRemainingMs(left, now) - getTimerRemainingMs(right, now);
  });
};

const HYDRATE_DELAY_MS = 600;
const ANNOUNCEMENT_CLEAR_MS = 8000;
const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const HEIGHT_PROPERTY = "--timer-dock-height";

const TimerRing: React.FC<{ fraction: number; done: boolean; paused: boolean }> = ({
  fraction,
  done,
  paused
}) => (
  <span aria-hidden="true" className="timer-dock-ring">
    <svg className="timer-dock-ring-svg" viewBox="0 0 40 40">
      <circle className="timer-dock-ring-track" cx="20" cy="20" r={RING_RADIUS} />
      <circle
        className="timer-dock-ring-fill"
        cx="20"
        cy="20"
        r={RING_RADIUS}
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, fraction)))}
      />
    </svg>
    <Icon name={done ? "bell" : paused ? "pause" : "timer"} size={16} strokeWidth={2.2} />
  </span>
);

const TimerRow: React.FC<{ timer: KitchenTimer; now: number; onItsRecipe: boolean }> = ({
  timer,
  now,
  onItsRecipe
}) => {
  const done = isTimerDone(timer, now);
  const remaining = getTimerRemainingMs(timer, now);
  const fraction = done ? 1 : timer.durationMs > 0 ? 1 - remaining / timer.durationMs : 0;
  const name = timer.label;
  const context = getTimerContextLabel(timer);
  // On the recipe that started it, the step says more than the recipe's name ("Step 5 · 10 min").
  const detail = onItsRecipe ? (
    timer.stepIndex != null ? (
      <span className="timer-dock-recipe num">{timer.label}</span>
    ) : null
  ) : timer.href ? (
    <Link className="timer-dock-recipe" to={timer.href}>
      {timer.recipeTitle}
    </Link>
  ) : (
    <span className="timer-dock-recipe">{timer.recipeTitle}</span>
  );

  return (
    <li
      className={[
        "timer-dock-item",
        done ? "is-done" : "",
        timer.paused && !done ? "is-paused" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <TimerRing done={done} fraction={fraction} paused={timer.paused} />
      <div className="timer-dock-text">
        <span className="timer-dock-time num" aria-hidden={done ? true : undefined}>
          {done ? "Done" : formatTimerClock(remaining)}
        </span>
        <span className="timer-dock-meta">
          <span className="timer-dock-label">{context}</span>
          {detail ? (
            <>
              <span aria-hidden="true" className="timer-dock-dot">
                ·
              </span>
              {detail}
            </>
          ) : null}
        </span>
      </div>
      <div className="timer-dock-actions">
        {done ? null : (
          <IconButton
            aria-label={timer.paused ? `Resume ${name} timer` : `Pause ${name} timer`}
            icon={timer.paused ? "play" : "pause"}
            onClick={() =>
              timer.paused ? resumeKitchenTimer(timer.id) : pauseKitchenTimer(timer.id)
            }
            size="sm"
            variant="tonal"
          />
        )}
        <button
          aria-label={`Add 1 minute to ${name} timer`}
          className="timer-dock-add num"
          onClick={() => addKitchenTimerTime(timer.id, 60_000)}
          type="button"
        >
          +1 min
        </button>
        <IconButton
          aria-label={done ? `Dismiss finished ${name} timer` : `Cancel ${name} timer`}
          icon={done ? "check" : "x"}
          onClick={() => dismissKitchenTimer(timer.id)}
          size="sm"
          variant={done ? "filled" : "ghost"}
        />
      </div>
    </li>
  );
};

/**
 * Kitchen timers, mounted once in the app shell. One compact card shows the timer that needs you
 * next (a finished one, else the soonest); "+N more" expands the rest. It sits above the tab bar
 * (clear of the raised Add button) or the recipe's action bar, moves inside cook mode while
 * cooking, and publishes its height as --timer-dock-height so pages keep their last rows
 * scrollable above it. It ticks only while a timer is running.
 */
export const TimerDock: React.FC = () => {
  const timers = useKitchenTimers();
  const host = useTimerDockHost();
  const location = useLocation();
  const listId = useId();
  const dockRef = useRef<HTMLElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const announcedRef = useRef(new Set<string>());
  const hasRunning = timers.some((timer) => !timer.paused && timer.doneAt == null);
  const hasTimers = timers.length > 0;
  const ordered = useMemo(() => sortTimersForDock(timers, now), [now, timers]);
  const extra = ordered.length - 1;
  const shown = expanded ? ordered : ordered.slice(0, 1);

  // Restore saved timers once the app has settled (they are rare; first paint matters more).
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void hydrateKitchenTimers();
    }, HYDRATE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    setNow(Date.now());

    if (!hasRunning) {
      return;
    }

    let timeoutId = 0;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      // Re-align to the next whole second so every visible clock changes together.
      timeoutId = window.setTimeout(tick, 1000 - (current % 1000) + 5);
    };

    timeoutId = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    return () => window.clearTimeout(timeoutId);
  }, [hasRunning, timers]);

  // Back to one card once only one timer is left.
  useEffect(() => {
    if (timers.length <= 1) {
      setExpanded(false);
    }
  }, [timers.length]);

  useEffect(() => {
    const finished = timers.filter(
      (timer) => timer.doneAt != null && !announcedRef.current.has(timer.id)
    );

    finished.forEach((timer) => announcedRef.current.add(timer.id));

    if (finished.length > 0) {
      setAnnouncement(finished.map((timer) => `${timer.label} timer is done.`).join(" "));
    }
  }, [timers]);

  // Clear it afterwards, so a region re-inserted later (the dock moving into cook mode) is empty.
  useEffect(() => {
    if (!announcement) {
      return;
    }

    const clear = window.setTimeout(() => setAnnouncement(""), ANNOUNCEMENT_CLEAR_MS);
    return () => window.clearTimeout(clear);
  }, [announcement]);

  // Publish the dock's height so page content (and toasts) can stay clear of it.
  useLayoutEffect(() => {
    const element = dockRef.current;
    const root = document.documentElement;

    if (!element || !hasTimers) {
      root.style.removeProperty(HEIGHT_PROPERTY);
      delete root.dataset.timerDock;
      return;
    }

    const measure = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      root.style.setProperty(HEIGHT_PROPERTY, `${height}px`);
    };

    measure();
    root.dataset.timerDock = "";

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);

    return () => {
      observer?.disconnect();
      root.style.removeProperty(HEIGHT_PROPERTY);
      delete root.dataset.timerDock;
    };
  }, [hasTimers, host]);

  const dock = (
    <aside
      aria-label="Kitchen timers"
      className={[
        "timer-dock",
        hasTimers ? "" : "is-empty",
        expanded ? "is-expanded" : "",
        host ? "is-in-cook-mode" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      data-timer-count={timers.length}
      ref={dockRef}
    >
      <p aria-live="assertive" className="sr-only" role="status">
        {announcement}
      </p>
      {extra > 0 ? (
        <button
          aria-controls={listId}
          aria-expanded={expanded}
          aria-label={expanded ? "Show only the next timer" : `Show all ${timers.length} timers`}
          className="timer-dock-more num"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? "Show less" : `+${extra} more`}
          <Icon name={expanded ? "chevron-down" : "chevron-up"} size={14} strokeWidth={2.4} />
        </button>
      ) : null}
      {hasTimers ? (
        <ul className={`timer-dock-list${!expanded && extra > 0 ? " is-stacked" : ""}`} id={listId}>
          {shown.map((timer) => (
            <TimerRow
              key={timer.id}
              now={now}
              onItsRecipe={Boolean(timer.href) && timer.href === location.pathname}
              timer={timer}
            />
          ))}
        </ul>
      ) : null}
    </aside>
  );

  return host ? createPortal(dock, host) : dock;
};
