import { useSyncExternalStore } from "react";

import { isStandaloneMode } from "./detect-installation";
import { isIos } from "./detect-ios";

/**
 * Chrome fires `beforeinstallprompt` once, early in the page load — usually before any install UI
 * has mounted. {@link captureInstallPrompt} runs at boot and keeps the event here so any screen can
 * offer "Install" later via {@link useInstallPrompt}.
 */

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export type InstallPlatform = "ios" | "android" | "desktop";

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

export interface InstallPromptState {
  /** The browser offered an install prompt we can show. */
  canInstall: boolean;
  /** Running as an installed app, or installed during this visit. */
  isInstalled: boolean;
  platform: InstallPlatform;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedDuringVisit = false;
let captured = false;
const listeners = new Set<() => void>();

const detectPlatform = (): InstallPlatform => {
  if (isIos()) {
    return "ios";
  }

  if (typeof navigator !== "undefined" && /android/iu.test(navigator.userAgent || "")) {
    return "android";
  }

  return "desktop";
};

const computeState = (): InstallPromptState => ({
  canInstall: deferredPrompt !== null,
  isInstalled: installedDuringVisit || isStandaloneMode(),
  platform: detectPlatform()
});

let state: InstallPromptState = {
  canInstall: false,
  isInstalled: false,
  platform: "desktop"
};

const refresh = (): void => {
  const next = computeState();

  if (
    next.canInstall !== state.canInstall ||
    next.isInstalled !== state.isInstalled ||
    next.platform !== state.platform
  ) {
    state = next;
    listeners.forEach((listener) => {
      listener();
    });
  }
};

/** Starts listening for the install prompt. Call once at boot, before React renders. */
export function captureInstallPrompt(): void {
  if (captured || typeof window === "undefined") {
    return;
  }

  captured = true;
  state = computeState();

  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep the prompt for our own install UI instead of the browser's mini-infobar.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    refresh();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installedDuringVisit = true;
    refresh();
  });

  try {
    window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", refresh);
  } catch {
    // Older browsers without MediaQueryList events just miss live display-mode changes.
  }
}

/** Shows the browser's install dialog if one is available. The prompt can only be used once. */
export async function promptInstall(): Promise<InstallOutcome> {
  const promptEvent = deferredPrompt;

  if (!promptEvent) {
    return "unavailable";
  }

  deferredPrompt = null;
  refresh();

  try {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;

    if (outcome === "accepted") {
      installedDuringVisit = true;
      refresh();
    }

    return outcome;
  } catch (error) {
    console.warn("Install prompt failed:", error);
    return "unavailable";
  }
}

export function getInstallPromptState(): InstallPromptState {
  // Idempotent: makes the store usable even if boot code did not capture yet (e.g. in tests).
  captureInstallPrompt();
  return state;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useInstallPrompt(): InstallPromptState & {
  promptInstall: () => Promise<InstallOutcome>;
} {
  const current = useSyncExternalStore(
    subscribeInstallPrompt,
    getInstallPromptState,
    getInstallPromptState
  );

  return { ...current, promptInstall };
}

/** Test seam. */
export function resetInstallPromptForTests(): void {
  deferredPrompt = null;
  installedDuringVisit = false;
  state = computeState();
  listeners.forEach((listener) => {
    listener();
  });
}
