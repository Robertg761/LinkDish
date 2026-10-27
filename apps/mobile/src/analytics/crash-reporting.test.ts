import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installCrashReporting,
  resetCrashReportingForTests,
  scrubCrashBreadcrumb,
  scrubCrashEvent
} from "./crash-reporting";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  platform: { OS: "android" }
}));

vi.mock("@sentry/react-native", () => ({
  init: mocks.init
}));

vi.mock("react-native", () => ({
  Platform: mocks.platform
}));

describe("installCrashReporting", () => {
  beforeEach(() => {
    mocks.init.mockReset();
    mocks.platform.OS = "android";
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

  it("stays off outside Android, which is all the privacy policy covers", () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.sentry.io/2");
    mocks.platform.OS = "ios";

    expect(installCrashReporting()).toBe(false);
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it("keeps the app starting and reports off if Sentry fails to initialize", () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.sentry.io/2");
    mocks.init.mockImplementation(() => {
      throw new Error("native module missing");
    });

    expect(installCrashReporting()).toBe(false);
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

  it("strips query strings from links in breadcrumb messages", () => {
    expect(
      scrubCrashBreadcrumb({
        category: "navigation",
        message: "opened https://example.com/r?id=1",
        data: { to: "/recipes" }
      })
    ).toEqual({
      category: "navigation",
      message: "opened https://example.com/r",
      data: { to: "/recipes" }
    });
  });
});

describe("scrubCrashEvent", () => {
  it("strips query strings from links in error messages and the request URL", () => {
    expect(
      scrubCrashEvent({
        type: undefined,
        message: "Failed https://example.com/recipe?id=123&token=abc.",
        exception: {
          values: [
            { type: "TypeError", value: 'Failed to load "https://site.com/r?x=1#top" twice' },
            { type: "Error" }
          ]
        },
        request: { url: "https://api.linkdish.ca/extract?url=secret" }
      })
    ).toEqual({
      type: undefined,
      message: "Failed https://example.com/recipe",
      exception: {
        values: [
          { type: "TypeError", value: 'Failed to load "https://site.com/r" twice' },
          { type: "Error" }
        ]
      },
      request: { url: "https://api.linkdish.ca/extract" }
    });
  });
});
