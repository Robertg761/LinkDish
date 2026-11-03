import * as Sentry from "@sentry/react-native";
import { Platform } from "react-native";

import type { Breadcrumb, ErrorEvent } from "@sentry/react-native";

/*
 * Crash reporting through Sentry, for the Android app only (the privacy policy covers Android).
 * It stays off unless the build sets EXPO_PUBLIC_SENTRY_DSN, so development builds and builds
 * without the DSN behave exactly as before.
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

const URL_QUERY_PATTERN = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;

// Recipe links and API requests carry their details in query strings; keep the address only.
export const stripUrlQueries = (text: string): string => text.replace(URL_QUERY_PATTERN, "$1");

// Console output can carry pasted recipe text, so it is dropped.
export const scrubCrashBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
  if (breadcrumb.category === "console") {
    return null;
  }

  const url: unknown = breadcrumb.data?.url;

  return {
    ...breadcrumb,
    ...(breadcrumb.message !== undefined ? { message: stripUrlQueries(breadcrumb.message) } : {}),
    ...(typeof url === "string"
      ? { data: { ...breadcrumb.data, url: url.replace(/[?#].*$/, "") } }
      : {})
  };
};

// Error messages (a failed fetch, for example) can quote a full link.
export const scrubCrashEvent = (event: ErrorEvent): ErrorEvent => ({
  ...event,
  ...(event.message !== undefined ? { message: stripUrlQueries(event.message) } : {}),
  ...(event.exception?.values
    ? {
        exception: {
          ...event.exception,
          values: event.exception.values.map((value) => ({
            ...value,
            ...(value.value !== undefined ? { value: stripUrlQueries(value.value) } : {})
          }))
        }
      }
    : {}),
  ...(event.request?.url !== undefined
    ? { request: { ...event.request, url: event.request.url.replace(/[?#].*$/, "") } }
    : {})
});

let crashReportingInstalled = false;

export const installCrashReporting = (): boolean => {
  const dsn = readPublicEnv(process.env.EXPO_PUBLIC_SENTRY_DSN);

  if (crashReportingInstalled || !dsn || Platform.OS !== "android") {
    return crashReportingInstalled;
  }

  try {
    Sentry.init({
      dsn,
      environment:
        readPublicEnv(process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT) ??
        (process.env.NODE_ENV === "production" ? "production" : "development"),
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeBreadcrumb: scrubCrashBreadcrumb,
      beforeSend: scrubCrashEvent
    });
    crashReportingInstalled = true;
  } catch {
    // Crash reporting must never stop the app from starting.
  }

  return crashReportingInstalled;
};

export const resetCrashReportingForTests = (): void => {
  crashReportingInstalled = false;
};
