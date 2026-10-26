import * as Sentry from "@sentry/react-native";

import type { Breadcrumb } from "@sentry/react-native";

/*
 * Crash reporting through Sentry. It stays off unless the build sets EXPO_PUBLIC_SENTRY_DSN, so
 * development builds and builds without the DSN behave exactly as before.
 *
 * The native SDK catches Java/Kotlin and NDK crashes and ANRs, and the JS SDK catches fatal JS
 * errors; both write the report to disk and send it on the next launch, which the first-party
 * client_error event cannot do once the process has died.
 */

const readPublicEnv = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

// Console output and request URLs can carry recipe links or pasted text; keep only the path.
export const scrubCrashBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
  if (breadcrumb.category === "console") {
    return null;
  }

  const url: unknown = breadcrumb.data?.url;

  if (typeof url === "string") {
    return {
      ...breadcrumb,
      data: {
        ...breadcrumb.data,
        url: url.replace(/[?#].*$/, "")
      }
    };
  }

  return breadcrumb;
};

let crashReportingInstalled = false;

export const installCrashReporting = (): boolean => {
  const dsn = readPublicEnv(process.env.EXPO_PUBLIC_SENTRY_DSN);

  if (crashReportingInstalled || !dsn) {
    return crashReportingInstalled;
  }

  crashReportingInstalled = true;

  try {
    Sentry.init({
      dsn,
      environment:
        readPublicEnv(process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT) ??
        (process.env.NODE_ENV === "production" ? "production" : "development"),
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeBreadcrumb: scrubCrashBreadcrumb
    });
  } catch {
    // Crash reporting must never stop the app from starting.
  }

  return crashReportingInstalled;
};

export const resetCrashReportingForTests = (): void => {
  crashReportingInstalled = false;
};
