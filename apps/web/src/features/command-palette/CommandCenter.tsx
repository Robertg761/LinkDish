import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { OPEN_COMMAND_PALETTE_EVENT } from "../../lib/command-palette-events";
import { createShortcutMatcher } from "../../lib/shortcuts";
import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";

import type { OpenCommandPaletteDetail } from "../../lib/command-palette-events";

const CommandPalette = lazyWithRetry(() =>
  import("./CommandPalette").then((module) => ({ default: module.CommandPalette }))
);
const ShortcutsHelpSheet = lazyWithRetry(() =>
  import("./ShortcutsHelpSheet").then((module) => ({ default: module.ShortcutsHelpSheet }))
);

/** Warm the palette's chunk (e.g. on hover of a search button) so ⌘K opens instantly. */
export const preloadCommandPalette = (): void => {
  void CommandPalette.preload().catch(() => undefined);
};

const PRELOAD_DELAY_MS = 4000;

type PaletteSource = OpenCommandPaletteDetail["source"];

/**
 * Always mounted and tiny: owns the global keyboard shortcuts (⌘K, "/", "?", "g c", "n") and the
 * open state of the command palette and the shortcuts sheet, whose UI loads on first use.
 */
export const CommandCenter: React.FC = () => {
  const navigate = useNavigate();
  const [paletteSource, setPaletteSource] = useState<PaletteSource | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const navigateRef = useRef(navigate);
  const paletteOpenRef = useRef(false);
  navigateRef.current = navigate;
  paletteOpenRef.current = paletteSource !== null;

  const closePalette = useCallback(() => setPaletteSource(null), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const showHelp = useCallback(() => setHelpOpen(true), []);

  useEffect(() => {
    const matcher = createShortcutMatcher();

    // Capture phase, so ⌘K wins over page handlers (the Cookbook's own ⌘K focus fallback sees
    // `defaultPrevented` and stands down); "/" is left to pages that have a search field.
    const handleKeyDown = (event: KeyboardEvent) => {
      const command = matcher.match(event, { paletteOpen: paletteOpenRef.current });

      if (!command) {
        return;
      }

      event.preventDefault();

      switch (command.type) {
        case "toggle-palette":
          setPaletteSource(null);
          return;
        case "open-palette":
          setPaletteSource("keyboard");
          return;
        case "show-help":
          setHelpOpen(true);
          return;
        case "go":
          void navigateRef.current(command.to);
          return;
        case "new-import":
          void navigateRef.current("/import");
      }
    };

    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<OpenCommandPaletteDetail | undefined>).detail;
      setPaletteSource(detail?.source ?? "other");
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handleRequest);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handleRequest);
    };
  }, []);

  // With a keyboard and mouse around, fetch the palette while the page is idle.
  useEffect(() => {
    const finePointer = (() => {
      try {
        return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      } catch {
        return false;
      }
    })();

    if (!finePointer) {
      return;
    }

    const timer = window.setTimeout(preloadCommandPalette, PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <>
      {paletteSource ? (
        <OptionalChunkBoundary name="Command palette" onError={closePalette}>
          <Suspense fallback={null}>
            <CommandPalette
              onClose={closePalette}
              onShowShortcuts={showHelp}
              source={paletteSource}
            />
          </Suspense>
        </OptionalChunkBoundary>
      ) : null}
      {helpOpen ? (
        <OptionalChunkBoundary name="Keyboard shortcuts" onError={closeHelp}>
          <Suspense fallback={null}>
            <ShortcutsHelpSheet onClose={closeHelp} />
          </Suspense>
        </OptionalChunkBoundary>
      ) : null}
    </>
  );
};
