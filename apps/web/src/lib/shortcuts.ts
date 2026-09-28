/**
 * App-wide keyboard shortcuts.
 *
 * ⌘K / Ctrl+K opens the command palette from anywhere (even a text field). Single keys — "?",
 * "/", "n" and the "g" then letter sequences — only fire when nobody is typing, no dialog is
 * open and no modifier is held, so they never steal a keystroke.
 */

export type ShortcutCommand =
  | { type: "toggle-palette" }
  | { type: "open-palette" }
  | { type: "show-help" }
  | { type: "go"; to: string }
  | { type: "new-import" };

export interface ShortcutDefinition {
  id: string;
  /** Key caps, in order; a two-key sequence is pressed one after the other. */
  keys: readonly string[];
  label: string;
  /** For `aria-keyshortcuts`. */
  aria: string;
  /** The keys are pressed one after another ("G then C") rather than together. */
  sequence?: boolean | undefined;
}

/** Sequence keys that follow "g". */
export const GO_TO_SHORTCUTS: Readonly<Record<string, { to: string; label: string }>> = {
  c: { label: "Cookbook", to: "/" },
  p: { label: "Meal plan", to: "/plan" },
  s: { label: "Shopping list", to: "/shopping" }
};

/** How long "g" waits for its second key. */
export const SEQUENCE_TIMEOUT_MS = 1200;

export const isMacLike = (): boolean => {
  try {
    return /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent);
  } catch {
    return false;
  }
};

/** "⌘K" on Apple devices, "Ctrl K" elsewhere. */
export const paletteShortcutLabel = (mac: boolean = isMacLike()): string => (mac ? "⌘K" : "Ctrl K");

export const getShortcutDefinitions = (mac: boolean = isMacLike()): ShortcutDefinition[] => [
  {
    aria: mac ? "Meta+K" : "Control+K",
    id: "palette",
    keys: mac ? ["⌘", "K"] : ["Ctrl", "K"],
    label: "Search recipes and commands"
  },
  { aria: "/", id: "search", keys: ["/"], label: "Search this page" },
  { aria: "G C", id: "go-cookbook", keys: ["G", "C"], label: "Go to Cookbook", sequence: true },
  { aria: "G P", id: "go-plan", keys: ["G", "P"], label: "Go to Meal plan", sequence: true },
  {
    aria: "G S",
    id: "go-shopping",
    keys: ["G", "S"],
    label: "Go to Shopping list",
    sequence: true
  },
  { aria: "N", id: "new-import", keys: ["N"], label: "Add a recipe" },
  { aria: "Shift+?", id: "help", keys: ["?"], label: "Show keyboard shortcuts" },
  { aria: "Escape", id: "close", keys: ["Esc"], label: "Close a dialog or sheet" }
];

/** The shortcut shown next to a rail destination, by path. */
export const RAIL_SHORTCUTS: Readonly<Record<string, { keys: readonly string[]; aria: string }>> = {
  "/": { aria: "G C", keys: ["G", "C"] },
  "/import": { aria: "N", keys: ["N"] },
  "/plan": { aria: "G P", keys: ["G", "P"] },
  "/shopping": { aria: "G S", keys: ["G", "S"] }
};

/** Text fields, editable content and open menus (whose type-ahead owns printable keys). */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || /^(textarea|select)$/iu.test(target.tagName)) {
    return true;
  }

  if (target instanceof HTMLInputElement) {
    return !/^(button|checkbox|radio|range|reset|submit|file|color|image)$/iu.test(target.type);
  }

  return target.closest("[role='menu'], [role='listbox'], [role='combobox']") !== null;
};

/** A modal dialog, sheet or cook mode is on screen. */
export const isModalOpen = (root: Document = document): boolean =>
  root.querySelector("[aria-modal='true']") !== null;

/** The current page has its own search field (it handles "/" itself). */
export const pageHasSearchField = (root: Document = document): boolean =>
  root.querySelector("#main-content input[type='search']") !== null;

export interface ShortcutEnvironment {
  isModalOpen: () => boolean;
  pageHasSearchField: () => boolean;
  now: () => number;
}

const defaultEnvironment: ShortcutEnvironment = {
  isModalOpen: () => isModalOpen(),
  now: () => Date.now(),
  pageHasSearchField: () => pageHasSearchField()
};

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  defaultPrevented: boolean;
  repeat?: boolean | undefined;
  isComposing?: boolean | undefined;
}

export interface ShortcutMatcher {
  /**
   * Returns the command for a keydown, or null. `paletteOpen` lets ⌘K close an open palette
   * (other modals block it). Call `preventDefault` on the event when a command is returned.
   */
  match: (event: ShortcutKeyEvent, state: { paletteOpen: boolean }) => ShortcutCommand | null;
  reset: () => void;
}

export const createShortcutMatcher = (
  environment: ShortcutEnvironment = defaultEnvironment
): ShortcutMatcher => {
  let pendingGoAt: number | null = null;

  const match: ShortcutMatcher["match"] = (event, { paletteOpen }) => {
    if (event.isComposing) {
      return null;
    }

    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const isPaletteCombo =
      (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && lower === "k";

    if (isPaletteCombo) {
      pendingGoAt = null;

      if (paletteOpen) {
        return { type: "toggle-palette" };
      }

      return environment.isModalOpen() ? null : { type: "open-palette" };
    }

    if (
      event.defaultPrevented ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      paletteOpen ||
      isTypingTarget(event.target) ||
      environment.isModalOpen()
    ) {
      pendingGoAt = null;
      return null;
    }

    const now = environment.now();

    if (pendingGoAt !== null) {
      const fresh = now - pendingGoAt <= SEQUENCE_TIMEOUT_MS;
      pendingGoAt = null;
      const destination = GO_TO_SHORTCUTS[lower];

      if (fresh && destination) {
        return { to: destination.to, type: "go" };
      }
    }

    if (lower === "g" && !event.shiftKey) {
      pendingGoAt = now;
      return null;
    }

    if (key === "?") {
      return { type: "show-help" };
    }

    if (lower === "n" && !event.shiftKey) {
      return { type: "new-import" };
    }

    // "/" belongs to the page's own search field when it has one.
    if (key === "/" && !environment.pageHasSearchField()) {
      return { type: "open-palette" };
    }

    return null;
  };

  return {
    match,
    reset: () => {
      pendingGoAt = null;
    }
  };
};
