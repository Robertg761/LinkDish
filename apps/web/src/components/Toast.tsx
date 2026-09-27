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
  /** Milliseconds before auto-dismiss. Defaults to 4s, or 6.5s when there is an action. */
  duration?: number | undefined;
  /** Replace any toast with the same id instead of queueing another one. */
  id?: string | undefined;
}

interface ToastRecord extends ToastOptions {
  id: string;
}

interface ToastContextValue {
  showToast: (options: ToastOptions) => string;
  dismissToast: (id: string) => void;
}

const MAX_VISIBLE_TOASTS = 3;
const DEFAULT_DURATION = 4000;
const ACTION_DURATION = 6500;

const noopToastContext: ToastContextValue = {
  showToast: () => "",
  dismissToast: () => undefined
};

const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;

const TONE_ICON: Record<ToastTone, IconName | null> = {
  default: null,
  success: "check-circle",
  danger: "alert-circle"
};

const ToastItem: React.FC<{ toast: ToastRecord; onDismiss: (id: string) => void }> = ({
  toast,
  onDismiss
}) => {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(
    toast.duration ?? (toast.action ? ACTION_DURATION : DEFAULT_DURATION)
  );
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (paused || remainingRef.current <= 0) {
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
      onBlur={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {icon ? <Icon name={icon} size={20} className="toast-icon" /> : null}
      <div className="toast-message">{toast.message}</div>
      {toast.action ? (
        <button
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
          type="button"
        >
          {toast.action.label}
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

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback((options: ToastOptions) => {
    toastCounter += 1;
    const id = options.id ?? `toast-${toastCounter}`;

    setToasts((current) => {
      const existingIndex = current.findIndex((toast) => toast.id === id);

      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = { ...options, id };
        return next;
      }

      return [...current, { ...options, id }];
    });

    return id;
  }, []);

  const value = useMemo(() => ({ showToast, dismissToast }), [dismissToast, showToast]);
  const visibleToasts = toasts.slice(0, MAX_VISIBLE_TOASTS);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-relevant="additions text"
          className="toast-region"
          role="status"
        >
          {visibleToasts.map((toast) => (
            <ToastItem key={toast.id} onDismiss={dismissToast} toast={toast} />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
};

/** Returns showToast/dismissToast. Outside a ToastProvider it is a harmless no-op. */
export const useToast = (): ToastContextValue => useContext(ToastContext) ?? noopToastContext;
