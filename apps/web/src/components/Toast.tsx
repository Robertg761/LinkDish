import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";

import { isMacLike, isTypingTarget } from "../lib/shortcuts";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./Toast.css";

export type ToastTone = "default" | "success" | "danger";

export interface ToastOptions {
  message: React.ReactNode;
  /** e.g. { label: "Undo", onClick: restore } — the toast closes after the action runs. */
  action?: { label: string; onClick: () => void } | undefined;
  tone?: ToastTone | undefined;
  icon?: IconName | undefined;
  /**
   * Milliseconds before auto-dismiss. Defaults to 4s, or 10s when there is an action (and no
   * auto-dismiss at all for an action shown after keyboard use).
   */
  duration?: number | undefined;
  /** Replace any toast with the same id instead of queueing another one. */
  id?: string | undefined;
}

interface ToastRecord extends ToastOptions {
  id: string;
  /** Shown while someone was using the keyboard: an action toast then waits to be dismissed. */
  keyboard: boolean;
}

interface ToastContextValue {
  showToast: (options: ToastOptions) => string;
  dismissToast: (id: string) => void;
}

const MAX_VISIBLE_TOASTS = 3;
const DEFAULT_DURATION = 4000;
const ACTION_DURATION = 10_000;
const UNDO_LABEL_PATTERN = /^undo$/iu;

const noopToastContext: ToastContextValue = {
  showToast: () => "",
  dismissToast: () => undefined
};

const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;

/*
 * Keyboard or pointer, whichever was used last. Undo toasts replace confirmation dialogs, so a
 * keyboard or screen-reader user must be able to reach Undo before it disappears: after
 * keyboard use an action toast stays until dismissed, Ctrl/⌘+Z runs the newest Undo, and F6
 * moves focus into the newest toast.
 */
let lastInputWasKeyboard = false;
let modalityListening = false;

const listenForInputModality = () => {
  if (modalityListening || typeof window === "undefined") {
    return;
  }

  modalityListening = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        lastInputWasKeyboard = true;
      }
    },
    true
  );
  window.addEventListener(
    "pointerdown",
    () => {
      lastInputWasKeyboard = false;
    },
    true
  );
};

const TONE_ICON: Record<ToastTone, IconName | null> = {
  default: null,
  success: "check-circle",
  danger: "alert-circle"
};

const ToastItem: React.FC<{
  toast: ToastRecord;
  undoShortcut: string | null;
  onDismiss: (id: string) => void;
}> = ({ toast, undoShortcut, onDismiss }) => {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(
    toast.action && toast.keyboard && toast.duration == null
      ? Number.POSITIVE_INFINITY
      : (toast.duration ?? (toast.action ? ACTION_DURATION : DEFAULT_DURATION))
  );
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (paused || remainingRef.current <= 0 || !Number.isFinite(remainingRef.current)) {
      return;
    }

    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remainingRef.current);

    return () => {
      window.clearTimeout(timer);
      remainingRef.current -= Date.now() - startedAtRef.current;
    };
  }, [onDismiss, paused, toast.id]);

  const tone = toast.tone ?? "default";
  const icon = toast.icon ?? TONE_ICON[tone];

  return (
    <div
      className={`toast toast-${tone}`}
      data-toast-id={toast.id}
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {icon ? <Icon name={icon} size={20} className="toast-icon" /> : null}
      <div className="toast-message">{toast.message}</div>
      {toast.action ? (
        <button
          aria-keyshortcuts={undoShortcut ?? undefined}
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
          type="button"
        >
          {toast.action.label}
          {undoShortcut ? (
            <kbd aria-hidden="true" className="toast-action-kbd">
              {isMacLike() ? "⌘Z" : "Ctrl Z"}
            </kbd>
          ) : null}
        </button>
      ) : null}
      <button
        aria-label="Dismiss notification"
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        type="button"
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
};

/**
 * Queues short confirmations ("Saved to Cookbook", "Removed · Undo"). Up to three are
 * visible, stacked above the phone tab bar; the rest wait their turn. Announced
 * politely to screen readers.
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const regionRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  useEffect(listenForInputModality, []);

  const dismissToast = useCallback((id: string) => {
    const item = Array.from(
      regionRef.current?.querySelectorAll<HTMLElement>("[data-toast-id]") ?? []
    ).find((element) => element.dataset.toastId === id);

    // Focus was inside the toast (F6 or Tab): give it back instead of dropping it on the page.
    if (item && document.activeElement && item.contains(document.activeElement)) {
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      const target = back && back.isConnected ? back : document.getElementById("main-content");
      target?.focus({ preventScroll: true });
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((options: ToastOptions) => {
    toastCounter += 1;
    const id = options.id ?? `toast-${toastCounter}`;
    const record: ToastRecord = { ...options, id, keyboard: lastInputWasKeyboard };

    setToasts((current) => {
      const existingIndex = current.findIndex((toast) => toast.id === id);

      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = record;
        return next;
      }

      return [...current, record];
    });

    return id;
  }, []);

  const visibleToasts = toasts.slice(0, MAX_VISIBLE_TOASTS);
  const newestUndo = [...visibleToasts]
    .reverse()
    .find((toast) => toast.action && UNDO_LABEL_PATTERN.test(toast.action.label));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const visible = toastsRef.current.slice(0, MAX_VISIBLE_TOASTS);

      if (visible.length === 0 || event.defaultPrevented) {
        return;
      }

      // Ctrl/⌘+Z: the newest Undo (text fields keep their own undo).
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "z" &&
        !isTypingTarget(event.target)
      ) {
        const undo = [...visible]
          .reverse()
          .find((toast) => toast.action && UNDO_LABEL_PATTERN.test(toast.action.label));

        if (undo?.action) {
          event.preventDefault();
          undo.action.onClick();
          dismissToast(undo.id);
        }

        return;
      }

      // F6: jump to the newest toast's action (the usual "next region" key).
      if (event.key === "F6" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const newest = regionRef.current?.querySelector<HTMLElement>(
          ".toast:last-child .toast-action, .toast:last-child .toast-close"
        );

        if (newest && !regionRef.current?.contains(document.activeElement)) {
          event.preventDefault();
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          newest.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dismissToast]);

  const value = useMemo(() => ({ showToast, dismissToast }), [dismissToast, showToast]);
  const undoShortcut = isMacLike() ? "Meta+Z" : "Control+Z";

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-relevant="additions text"
          className="toast-region"
          ref={regionRef}
          role="status"
        >
          {visibleToasts.map((toast) => (
            <ToastItem
              key={toast.id}
              onDismiss={dismissToast}
              toast={toast}
              undoShortcut={toast === newestUndo ? undoShortcut : null}
            />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
};

/** Returns showToast/dismissToast. Outside a ToastProvider it is a harmless no-op. */
export const useToast = (): ToastContextValue => useContext(ToastContext) ?? noopToastContext;
