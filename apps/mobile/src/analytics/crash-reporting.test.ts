import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installCrashReporting,
  resetCrashReportingForTests,
  scrubCrashBreadcrumb
} from "./crash-reporting";

const mocks = vi.hoisted(() => ({
  init: vi.fn()
}));

vi.mock("@sentry/react-native", () => ({
  init: mocks.init
}));

describe("installCrashReporting", () => {
  beforeEach(() => {
    mocks.init.mockReset();
    resetCrashReportingForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays off when the build has no Sentry DSN", () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "  ");

    expect(installCrashReporting()).toBe(false);
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("starts Sentry once without personal data or tracing", () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.sentry.io/2");
    vi.stubEnv("EXPO_PUBLIC_SENTRY_ENVIRONMENT", "preview");

    expect(installCrashReporting()).toBe(true);
    expect(installCrashReporting()).toBe(true);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://key@o1.ingest.sentry.io/2",
        environment: "preview",
        sendDefaultPii: false,
        tracesSampleRate: 0
      })
    );
  });

  it("keeps the app starting if Sentry fails to initialize", () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.sentry.io/2");
    mocks.init.mockImplementation(() => {
      throw new Error("native module missing");
    });

    expect(() => installCrashReporting()).not.toThrow();
  });
});

describe("scrubCrashBreadcrumb", () => {
  it("drops console breadcrumbs", () => {
    expect(scrubCrashBreadcrumb({ category: "console", message: "pasted recipe" })).toBeNull();
  });

  it("strips query strings and fragments from request URLs", () => {
    expect(
      scrubCrashBreadcrumb({
        category: "fetch",
        data: {
          method: "POST",
          url: "https://api.linkdish.ca/extract?url=https%3A%2F%2Fexample.com#top"
        }
      })
    ).toEqual({
      category: "fetch",
      data: {
        method: "POST",
        url: "https://api.linkdish.ca/extract"
      }
    });
  });

  it("keeps other breadcrumbs unchanged", () => {
    const breadcrumb = { category: "navigation", data: { to: "/recipes" } };

    expect(scrubCrashBreadcrumb(breadcrumb)).toBe(breadcrumb);
  });
});
