import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router-dom";

import { focusPageHeading, pageNameFromTitle } from "./route-focus";

const MAX_RESTORE_FRAMES = 60;
/** Lets the page set its own document.title (e.g. the recipe name) before it is announced. */
const POP_ANNOUNCE_DELAY_MS = 400;

/**
 * Scroll restoration and route focus for the SPA: new pages (PUSH/REPLACE) start at the top,
 * and Back/Forward (POP) returns to where you were — retrying for a moment while a lazy page or
 * IndexedDB list renders enough height. On in-app navigation, focus moves to the new page's main
 * heading (so a screen reader reads it); when a page has no heading, focus goes to <main> and a
 * polite live region announces the page instead, as it does after Back/Forward.
 */
export const ScrollManager: React.FC = () => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positionsRef = useRef(new Map<string, number>());
  const currentKeyRef = useRef(location.key);
  const isFirstRenderRef = useRef(true);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    try {
      window.history.scrollRestoration = "manual";
    } catch {
      // Some embedded browsers do not allow changing this; native restoration is fine.
    }
  }, []);

  useEffect(() => {
    let frame = 0;
    const handleScroll = () => {
      if (frame) {
        return;
      }

      frame = window.requestAnimationFrame(() => {
        frame = 0;
        positionsRef.current.set(currentKeyRef.current, window.scrollY);
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);

      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  useLayoutEffect(() => {
    currentKeyRef.current = location.key;

    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      return;
    }

    if (location.hash) {
      return;
    }

    if (navigationType !== NavigationType.Pop) {
      window.scrollTo(0, 0);
      setAnnouncement("");

      return focusPageHeading({
        onFallback: () => {
          setAnnouncement(pageNameFromTitle(document.title));
        }
      });
    }

    const target = positionsRef.current.get(location.key) ?? 0;
    let attempts = 0;
    let frame = 0;
    // Back/Forward keeps focus and the restored scroll position; just say where we are.
    setAnnouncement("");
    const announceTimer = window.setTimeout(() => {
      setAnnouncement(pageNameFromTitle(document.title));
    }, POP_ANNOUNCE_DELAY_MS);

    const restore = () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;

      if (maxScroll >= target || attempts >= MAX_RESTORE_FRAMES) {
        window.scrollTo(0, Math.min(target, Math.max(0, maxScroll)));
        return;
      }

      attempts += 1;
      frame = window.requestAnimationFrame(restore);
    };

    restore();

    return () => {
      window.clearTimeout(announceTimer);

      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [location.key, location.hash, navigationType]);

  return (
    <p aria-atomic="true" aria-live="polite" className="sr-only" data-testid="route-announcer">
      {announcement}
    </p>
  );
};
