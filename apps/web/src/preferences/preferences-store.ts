import { useSyncExternalStore } from "react";

import { safeGetItem, safeSetItem } from "../platform/safe-storage";

export type ThemePreference = "system" | "light" | "dark";
export type UnitsPreference = "original" | "us" | "metric";
export type CookTextSize = "md" | "lg" | "xl";
export type WeekStartsOn = 0 | 1;

export interface Preferences {
  theme: ThemePreference;
  units: UnitsPreference;
  keepScreenAwake: boolean;
  cookTextSize: CookTextSize;
  /** 0 = Sunday, 1 = Monday. */
  weekStartsOn: WeekStartsOn;
}

export const PREFERENCES_STORAGE_KEY = "linkdish:web:preferences:v1";

/** Browser theme-color per resolved theme (status bar / title bar tint). */
export const THEME_COLORS = { light: "#f4efe7", dark: "#1a1816" } as const;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: "system",
  units: "original",
  keepScreenAwake: true,
  cookTextSize: "md",
  weekStartsOn: getDefaultWeekStart()
});

function getDefaultWeekStart(): WeekStartsOn {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;

    return firstDay === 7 ? 0 : 1;
  } catch {
    return 0;
  }
}

const isOneOf = <T extends string | number>(value: unknown, options: readonly T[]): value is T =>
  options.includes(value as T);

/** Keeps only valid, known fields so a corrupt or older payload never breaks the app. */
export const parsePreferences = (raw: string | null): Preferences => {
  const defaults = { ...DEFAULT_PREFERENCES };

  if (!raw) {
    return defaults;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return defaults;
    }

    const candidate = parsed as Record<string, unknown>;

    return {
      theme: isOneOf(candidate.theme, ["system", "light", "dark"] as const)
        ? candidate.theme
        : defaults.theme,
      units: isOneOf(candidate.units, ["original", "us", "metric"] as const)
        ? candidate.units
        : defaults.units,
      keepScreenAwake:
        typeof candidate.keepScreenAwake === "boolean"
          ? candidate.keepScreenAwake
          : defaults.keepScreenAwake,
      cookTextSize: isOneOf(candidate.cookTextSize, ["md", "lg", "xl"] as const)
        ? candidate.cookTextSize
        : defaults.cookTextSize,
      weekStartsOn: isOneOf(candidate.weekStartsOn, [0, 1] as const)
        ? candidate.weekStartsOn
        : defaults.weekStartsOn
    };
  } catch {
    return defaults;
  }
};

let currentPreferences: Preferences | null = null;
const listeners = new Set<() => void>();

const readPreferences = (): Preferences => {
  if (!currentPreferences) {
    currentPreferences = parsePreferences(safeGetItem(PREFERENCES_STORAGE_KEY));
  }

  return currentPreferences;
};

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const getPreferences = (): Preferences => readPreferences();

export const setPreferences = (patch: Partial<Preferences>): void => {
  const next = { ...readPreferences(), ...patch };
  currentPreferences = next;
  // Persisting can fail (private mode); the in-memory value still applies this session.
  safeSetItem(PREFERENCES_STORAGE_KEY, JSON.stringify(next));

  if (patch.theme !== undefined) {
    applyThemePreference(next.theme);
  }

  emit();
};

export const setPreference = <K extends keyof Preferences>(key: K, value: Preferences[K]): void => {
  setPreferences({ [key]: value } as Pick<Preferences, K>);
};

export const subscribePreferences = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/** Resolves "system" against the OS setting. */
export const resolveTheme = (theme: ThemePreference): "light" | "dark" => {
  if (theme !== "system") {
    return theme;
  }

  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
};

/**
 * Applies the theme to <html data-theme>. "system" removes the attribute so the
 * prefers-color-scheme media query in tokens.css decides. Also retints the
 * theme-color metas so the status bar matches a forced theme.
 */
export const applyThemePreference = (theme: ThemePreference, root: Document = document): void => {
  const html = root.documentElement;

  if (theme === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }

  const metas = root.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');

  metas.forEach((meta) => {
    const media = meta.getAttribute("media") ?? "";
    const schemeForMeta: "light" | "dark" = media.includes("dark") ? "dark" : "light";
    const color = theme === "system" ? THEME_COLORS[schemeForMeta] : THEME_COLORS[theme];
    meta.setAttribute("content", color);
  });
};

/** Re-reads storage when another tab changes preferences. */
export const handlePreferencesStorageEvent = (event: StorageEvent): void => {
  if (event.key !== PREFERENCES_STORAGE_KEY) {
    return;
  }

  const previousTheme = readPreferences().theme;
  currentPreferences = parsePreferences(event.newValue);

  if (currentPreferences.theme !== previousTheme) {
    applyThemePreference(currentPreferences.theme);
  }

  emit();
};

let initialized = false;

/** Applies the stored theme and starts cross-tab sync. Safe to call more than once. */
export const initPreferences = (): void => {
  applyThemePreference(readPreferences().theme);

  if (initialized) {
    return;
  }

  initialized = true;
  window.addEventListener("storage", handlePreferencesStorageEvent);
};

const getServerSnapshot = (): Preferences => DEFAULT_PREFERENCES;

export const usePreferences = (): Preferences =>
  useSyncExternalStore(subscribePreferences, readPreferences, getServerSnapshot);

export const usePreference = <K extends keyof Preferences>(key: K): Preferences[K] =>
  usePreferences()[key];

export const resetPreferencesForTests = (): void => {
  currentPreferences = null;
  listeners.clear();

  if (initialized) {
    window.removeEventListener("storage", handlePreferencesStorageEvent);
    initialized = false;
  }
};
