import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";

import {
  addKitchenTimerTime,
  dismissKitchenTimer,
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

/** "4:05", "12:30", "1:02:09" */
export const formatTimerClock = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

const HYDRATE_DELAY_MS = 600;
const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

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

const TimerRow: React.FC<{ timer: KitchenTimer; now: number }> = ({ timer, now }) => {
  const done = isTimerDone(timer, now);
  const remaining = getTimerRemainingMs(timer, now);
  const fraction = done ? 1 : timer.durationMs > 0 ? 1 - remaining / timer.durationMs : 0;
  const name = timer.label;
  const context = getTimerContextLabel(timer);
  const title = timer.href ? (
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
          <span aria-hidden="true" className="timer-dock-dot">
            ·
          </span>
          {title}
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
 * The floating stack of kitchen timers, mounted once in the app shell. It sits above the tab bar
 * (and above cook mode's footer while cooking), survives navigation and closing cook mode, and
 * ticks only while a timer is running.
 */
export const TimerDock: React.FC = () => {
  const timers = useKitchenTimers();
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const announcedRef = useRef(new Set<string>());
  const hasRunning = timers.some((timer) => !timer.paused && timer.doneAt == null);

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

  useEffect(() => {
    const finished = timers.filter(
      (timer) => timer.doneAt != null && !announcedRef.current.has(timer.id)
    );

    finished.forEach((timer) => announcedRef.current.add(timer.id));

    if (finished.length > 0) {
      setAnnouncement(finished.map((timer) => `${timer.label} timer is done.`).join(" "));
    }
  }, [timers]);

  return (
    <aside
      aria-label="Kitchen timers"
      className={`timer-dock${timers.length === 0 ? " is-empty" : ""}`}
      data-timer-count={timers.length}
    >
      <p aria-live="assertive" className="sr-only" role="status">
        {announcement}
      </p>
      {timers.length > 0 ? (
        <ul className="timer-dock-list">
          {timers.map((timer) => (
            <TimerRow key={timer.id} now={now} timer={timer} />
          ))}
        </ul>
      ) : null}
    </aside>
  );
};
