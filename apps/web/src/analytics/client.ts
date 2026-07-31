import { apiClient } from "../api/client";

import { createWebAnalyticsId, getWebAnalyticsClientId, getWebAnalyticsSessionId } from "./session";

import type { AnalyticsEventInput, AnalyticsEventName } from "@linkdish/api-contracts";
import type { V2AnalyticsEvent } from "@linkdish/utils";

type WebAnalyticsEvent = Omit<
  AnalyticsEventInput,
  "anonymousId" | "eventName" | "platform" | "sessionId"
> & {
  eventName: AnalyticsEventName;
};

const getReferrerHostname = (): string | undefined => {
  if (!document.referrer) {
    return undefined;
  }

  try {
    return new URL(document.referrer).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
};

const getUtmParams = () => {
  const params = new URLSearchParams(window.location.search);

  return {
    utmCampaign: params.get("utm_campaign") ?? undefined,
    utmMedium: params.get("utm_medium") ?? undefined,
    utmSource: params.get("utm_source") ?? undefined
  };
};

export const trackWebEvent = (event: WebAnalyticsEvent): void => {
  const payload: AnalyticsEventInput = {
    ...event,
    ...getUtmParams(),
    anonymousId: getWebAnalyticsClientId(),
    occurredAt: new Date().toISOString(),
    platform: "web_app",
    referrerHostname: event.referrerHostname ?? getReferrerHostname(),
    requestId: event.requestId ?? `web:${createWebAnalyticsId()}`,
    sessionId: getWebAnalyticsSessionId()
  };

  void apiClient.sendAnalyticsEvents({ events: [payload] }).catch(() => {
    // Analytics should never interrupt the product flow.
  });
};

export const trackWebV2AnalyticsEvent = <EventName extends V2AnalyticsEvent["name"]>(
  event: V2AnalyticsEvent<EventName>
): void => {
  trackWebEvent({
    eventName: event.name,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.routeOrScreen ? { routeOrScreen: event.routeOrScreen } : {}),
    properties: event.properties
  });
};

export const trackWebError = (error: unknown, routeOrScreen: string): void => {
  trackWebEvent({
    eventName: "client_error",
    routeOrScreen,
    properties: {
      message:
        error instanceof Error && error.message.trim()
          ? error.message.slice(0, 160)
          : "Unknown client error"
    }
  });
};

let webErrorTrackingInstalled = false;

export const installWebErrorTracking = (): void => {
  if (webErrorTrackingInstalled) {
    return;
  }

  webErrorTrackingInstalled = true;

  window.addEventListener("error", (event) => {
    trackWebError(event.error ?? event.message, window.location.pathname);
  });

  window.addEventListener("unhandledrejection", (event) => {
    trackWebError(event.reason, window.location.pathname);
  });
};
