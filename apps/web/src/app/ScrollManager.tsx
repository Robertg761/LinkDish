import { useEffect, useLayoutEffect, useRef } from "react";
import { NavigationType, useLocation, useNavigationType } from "react-router-dom";

const MAX_RESTORE_FRAMES = 60;

/**
 * Scroll restoration for the SPA: new pages (PUSH/REPLACE) start at the top, and
 * Back/Forward (POP) returns to where you were — retrying for a moment while a lazy
 * page or IndexedDB list renders enough height. Keyboard and screen-reader users get
 * focus moved to <main> on in-app navigation.
 */
export const ScrollManager = (): null => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positionsRef = useRef(new Map<string, number>());
  const currentKeyRef = useRef(location.key);
  const isFirstRenderRef = useRef(true);

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
      document.getElementById("main-content")?.focus({ preventScroll: true });
      return;
    }

    const target = positionsRef.current.get(location.key) ?? 0;
    let attempts = 0;
    let frame = 0;

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
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [location.key, location.hash, navigationType]);

  return null;
};
