/**
 * How a finished kitchen timer gets your attention: a soft chime (WebAudio), a vibration, a
 * flashing tab title and a system notification. Every cue is best effort and fails silently.
 */

const TITLE_FLASH_INTERVAL_MS = 800;
const TITLE_FLASH_VISIBLE_TICKS = 12;
const TITLE_FLASH_MAX_TICKS = 450;
const SERVICE_WORKER_READY_TIMEOUT_MS = 1500;
const VIBRATION_PATTERN = [220, 120, 220, 120, 420];
const NOTIFICATION_ICON = "/icons/icon-192.png";

/* ------------------------------------------------------------------------------------------------
 * Chime
 * ---------------------------------------------------------------------------------------------- */

type AudioContextConstructor = typeof AudioContext;

let audioContext: AudioContext | null = null;

const getAudioContextConstructor = (): AudioContextConstructor | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: AudioContextConstructor })
        .webkitAudioContext);

const getAudioContext = (): AudioContext | null => {
  if (audioContext) {
    return audioContext;
  }

  const Constructor = getAudioContextConstructor();

  if (!Constructor) {
    return null;
  }

  try {
    audioContext = new Constructor();
  } catch {
    audioContext = null;
  }

  return audioContext;
};

/**
 * Browsers only let audio start after a user gesture, so the audio context is created (or
 * resumed) when a timer is started and reused when it finishes.
 */
export const primeTimerAudio = (): void => {
  const context = getAudioContext();

  if (context?.state === "suspended") {
    void context.resume?.().catch(() => undefined);
  }
};

/** Three rising notes — a kitchen "ding-ding-ding" that is noticeable but not alarming. */
export const playTimerChime = (): void => {
  const context = getAudioContext();

  if (!context) {
    return;
  }

  try {
    if (context.state === "suspended") {
      void context.resume?.().catch(() => undefined);
    }

    const start = context.currentTime + 0.02;
    [659.25, 783.99, 987.77].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + index * 0.22;

      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.12, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.6);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.62);
    });
  } catch {
    // The title flash and the notification still carry the cue.
  }
};

/* ------------------------------------------------------------------------------------------------
 * Vibration
 * ---------------------------------------------------------------------------------------------- */

export const vibrateForTimer = (): void => {
  try {
    navigator.vibrate?.(VIBRATION_PATTERN);
  } catch {
    // Not supported (desktop, iOS) or blocked.
  }
};

/* ------------------------------------------------------------------------------------------------
 * Tab title flash
 * ---------------------------------------------------------------------------------------------- */

interface TitleFlash {
  /** The real page title, restored when the flash ends. */
  base: string;
  text: string;
  ticks: number;
  intervalId: number;
}

let titleFlash: TitleFlash | null = null;

/** Restores the page title and stops flashing. */
export const stopTitleFlash = (): void => {
  if (!titleFlash) {
    return;
  }

  window.clearInterval(titleFlash.intervalId);

  if (document.title === titleFlash.text) {
    document.title = titleFlash.base;
  }

  titleFlash = null;
};

/**
 * Alternates the tab title with `text`. A second timer finishing mid-flash only swaps the text,
 * so the original title is always what comes back (the old version could get stuck on
 * "Timer done"). A title change by the app while flashing (navigation) becomes the new base.
 * It keeps flashing while the tab is hidden and stops a few seconds after you come back.
 */
export const flashDocumentTitle = (text: string): void => {
  if (typeof document === "undefined") {
    return;
  }

  if (titleFlash) {
    // Put the real title back before swapping the text, so the old flash text is never
    // mistaken for a title the app set (that was the stuck-title bug).
    if (document.title === titleFlash.text) {
      document.title = titleFlash.base;
    }

    titleFlash.text = text;
    titleFlash.ticks = 0;
    return;
  }

  const flash: TitleFlash = {
    base: document.title,
    intervalId: 0,
    text,
    ticks: 0
  };

  flash.intervalId = window.setInterval(() => {
    if (titleFlash !== flash) {
      return;
    }

    if (document.title !== flash.text && document.title !== flash.base) {
      flash.base = document.title;
    }

    flash.ticks += 1;
    document.title = flash.ticks % 2 === 1 ? flash.text : flash.base;

    const hidden = document.visibilityState === "hidden";

    if (
      (!hidden && flash.ticks >= TITLE_FLASH_VISIBLE_TICKS && flash.ticks % 2 === 0) ||
      flash.ticks >= TITLE_FLASH_MAX_TICKS
    ) {
      stopTitleFlash();
    }
  }, TITLE_FLASH_INTERVAL_MS);

  titleFlash = flash;
};

/* ------------------------------------------------------------------------------------------------
 * Notifications
 * ---------------------------------------------------------------------------------------------- */

let hasRequestedPermission = false;

const notificationsSupported = (): boolean =>
  typeof window !== "undefined" && typeof window.Notification === "function";

/** Asks for notification permission once, on the first timer start, when it is undecided. */
export const requestTimerNotificationPermission = (): void => {
  if (hasRequestedPermission || !notificationsSupported()) {
    return;
  }

  if (
    Notification.permission !== "default" ||
    typeof Notification.requestPermission !== "function"
  ) {
    return;
  }

  hasRequestedPermission = true;

  try {
    void Promise.resolve(Notification.requestPermission()).catch(() => undefined);
  } catch {
    // Some embedded browsers throw instead of rejecting.
  }
};

const getServiceWorkerRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;

  if (!container?.ready) {
    return null;
  }

  let timeoutId = 0;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(null), SERVICE_WORKER_READY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([container.ready, timeout]);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

/**
 * Shows a system notification through the service worker (`registration.showNotification`),
 * which is the only form Android Chrome and installed PWAs allow — `new Notification()` throws
 * "Illegal constructor" there. Without a service worker it falls back to the constructor, and
 * any failure is silent.
 */
export const showTimerNotification = async (options: {
  title: string;
  body: string;
  tag: string;
}): Promise<"service-worker" | "constructor" | "none"> => {
  if (!notificationsSupported() || Notification.permission !== "granted") {
    return "none";
  }

  const notificationOptions: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    badge: NOTIFICATION_ICON,
    body: options.body,
    icon: NOTIFICATION_ICON,
    renotify: true,
    tag: options.tag,
    vibrate: VIBRATION_PATTERN
  };

  try {
    const registration = await getServiceWorkerRegistration();

    if (registration && typeof registration.showNotification === "function") {
      await registration.showNotification(options.title, notificationOptions);
      return "service-worker";
    }
  } catch {
    // Fall through to the constructor.
  }

  try {
    new Notification(options.title, {
      body: options.body,
      icon: NOTIFICATION_ICON,
      tag: options.tag
    });
    return "constructor";
  } catch {
    return "none";
  }
};

/** Test seam: forgets the one-time permission request, the audio context and any title flash. */
export const resetTimerAlertsForTests = (): void => {
  hasRequestedPermission = false;
  audioContext = null;

  if (titleFlash) {
    window.clearInterval(titleFlash.intervalId);
    titleFlash = null;
  }
};
