import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyThemePreference,
  DEFAULT_PREFERENCES,
  getPreferences,
  handlePreferencesStorageEvent,
  initPreferences,
  parsePreferences,
  PREFERENCES_STORAGE_KEY,
  resetPreferencesForTests,
  setPreference,
  usePreferences
} from "./preferences-store";

const analytics = vi.hoisted(() => ({ trackWebEvent: vi.fn<(event: unknown) => void>() }));
vi.mock("../analytics/client", () => ({ trackWebEvent: analytics.trackWebEvent }));

const addThemeColorMetas = () => {
  document.head.innerHTML = `
    <meta name="theme-color" content="#f4efe7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#1a1816" media="(prefers-color-scheme: dark)" />
  `;
};

describe("preferences store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPreferencesForTests();
    document.documentElement.removeAttribute("data-theme");
    addThemeColorMetas();
  });

  afterEach(() => {
    resetPreferencesForTests();
  });

  it("falls back to defaults for missing or corrupt storage", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("{not json")).toEqual(DEFAULT_PREFERENCES);
    expect(
      parsePreferences(JSON.stringify({ theme: "sepia", units: "metric", weekStartsOn: 3 }))
    ).toEqual({ ...DEFAULT_PREFERENCES, units: "metric" });
  });

  it("persists a preference and notifies hook subscribers", () => {
    const { result } = renderHook(() => usePreferences());

    expect(result.current.units).toBe("original");

    act(() => {
      setPreference("units", "metric");
    });

    expect(result.current.units).toBe("metric");
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}")).toMatchObject({
      units: "metric"
    });
  });

  it("reports theme and units changes (not re-selecting the same value)", () => {
    analytics.trackWebEvent.mockReset();

    setPreference("theme", "dark");
    setPreference("theme", "dark");
    setPreference("units", "metric");
    setPreference("cookTextSize", "xl");

    expect(analytics.trackWebEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ eventName: "theme_changed", properties: { theme: "dark" } }),
      expect.objectContaining({ eventName: "units_changed", properties: { units: "metric" } })
    ]);
  });

  it("applies a forced theme to <html> and the theme-color metas", () => {
    setPreference("theme", "dark");

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      expect(meta).toHaveAttribute("content", "#1a1816");
    });

    setPreference("theme", "system");

    expect(document.documentElement).not.toHaveAttribute("data-theme");
    const [lightMeta, darkMeta] = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    expect(lightMeta).toHaveAttribute("content", "#f4efe7");
    expect(darkMeta).toHaveAttribute("content", "#1a1816");
  });

  it("restores the stored theme on init", () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ theme: "light" }));

    initPreferences();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(getPreferences().theme).toBe("light");
  });

  it("picks up changes made in another tab", () => {
    const { result } = renderHook(() => usePreferences());

    act(() => {
      handlePreferencesStorageEvent(
        new StorageEvent("storage", {
          key: PREFERENCES_STORAGE_KEY,
          newValue: JSON.stringify({ theme: "dark", cookTextSize: "xl" })
        })
      );
    });

    expect(result.current.cookTextSize).toBe("xl");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("does not throw when applying themes without metas", () => {
    document.head.innerHTML = "";

    expect(() => applyThemePreference("light")).not.toThrow();
  });
});
