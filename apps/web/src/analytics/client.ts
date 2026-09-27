import { apiBaseUrl } from "../api/base-url";
import { getStableClientId } from "../platform/stable-client-id";

import { createWebAnalyticsId, getWebAnalyticsClientId, getWebAnalyticsSessionId } from "./session";

import type {
  AnalyticsEventInput,
  AnalyticsEventName,
  analyticsEventInputSchema
} from "@linkdish/api-contracts";
import type { V2AnalyticsEvent } from "@linkdish/utils";

/**
 * Batched, fire-and-forget product analytics.
 *
 * Events are sanitized when tracked and validated against the contract before sending (never
 * throwing), queued in memory, and sent in batches of up to 25: five seconds after the first
 * queued event, as soon as 25 are waiting, and with `navigator.sendBeacon` when the page is hidden
 * or unloaded so the last events survive. Analytics requests never carry the Authorization header.
 *
 * The zod contract is loaded lazily (it shares the API client's chunk), keeping it out of the
 * entry bundle. Until it has loaded, events are sent with structural sanitizing only.
 */

type WebAnalyticsEvent = Omit<
  AnalyticsEventInput,
  "anonymousId" | "eventName" | "platform" | "sessionId"
> & {
  eventName: AnalyticsEventName;
};

type AnalyticsPropertyValue = string | number | boolean | null;

export const ANALYTICS_MAX_BATCH_SIZE = 25;
export const ANALYTICS_FLUSH_DELAY_MS = 5_000;
const MAX_QUEUE_SIZE = 250;
const KEEPALIVE_BODY_LIMIT = 60_000;
const MAX_PROPERTY_KEY_LENGTH = 80;
const MAX_PROPERTY_STRING_LENGTH = 500;
const NON_STRING_PROPERTY_CHARS = 8;
const REQUEST_ID_PATTERN = /^[a-z0-9:_-]+$/iu;
const ERROR_DEDUPE_WINDOW_MS = 10_000;
// Mirrors MAX_ANALYTICS_EVENT_PROPERTY_COUNT / MAX_ANALYTICS_EVENT_PROPERTIES_CHARS in
// @linkdish/api-contracts (inlined so this module does not pull the contracts into the entry).
const MAX_ANALYTICS_EVENT_PROPERTY_COUNT = 40;
const MAX_ANALYTICS_EVENT_PROPERTIES_CHARS = 4_000;

type EventSchema = typeof analyticsEventInputSchema;

let eventSchema: EventSchema | null = null;
let eventSchemaLoading: Promise<EventSchema | null> | null = null;

/** Loads the contract used to validate events (shared chunk with the API client). */
export function loadAnalyticsValidator(): Promise<EventSchema | null> {
  if (eventSchema) {
    return Promise.resolve(eventSchema);
  }

  eventSchemaLoading ??= import("@linkdish/api-contracts").then(
    (contracts) => {
      eventSchema = contracts.analyticsEventInputSchema;
      return eventSchema;
    },
    (error: unknown) => {
      debug("could not load the analytics contract", error);
      eventSchemaLoading = null;
      return null;
    }
  );

  return eventSchemaLoading;
}

export interface AnalyticsTransport {
  /** Returns true when the browser accepted the beacon. */
  beacon: (url: string, body: string) => boolean;
  send: (url: string, body: string, headers: Record<string, string>) => Promise<Response>;
}

const defaultTransport: AnalyticsTransport = {
  beacon(url, body) {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
      return false;
    }

    try {
      // text/plain keeps the beacon a CORS "simple" request (no preflight); the API parses JSON.
      return navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }));
    } catch {
      return false;
    }
  },
  send(url, body, headers) {
    return fetch(url, {
      body,
      credentials: "omit",
      headers,
      keepalive: body.length <= KEEPALIVE_BODY_LIMIT,
      method: "POST"
    });
  }
};

/** Unit tests must never post to the real API; they inject a transport when they need one. */
const silentTransport: AnalyticsTransport = {
  beacon: () => true,
  send: () => Promise.resolve(new Response(null, { status: 202 }))
};

const baseTransport: AnalyticsTransport =
  import.meta.env.MODE === "test" ? silentTransport : defaultTransport;

let transport: AnalyticsTransport = baseTransport;
let queue: AnalyticsEventInput[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleInstalled = false;
const retriedEvents = new WeakSet<AnalyticsEventInput>();
const recentErrors = new Map<string, number>();

const debug = (message: string, detail?: unknown): void => {
  try {
    console.debug(`[analytics] ${message}`, detail ?? "");
  } catch {
    // Console access can fail in locked-down embeds; analytics must never throw.
  }
};

const cleanString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const getReferrerHostname = (): string | undefined => {
  if (typeof document === "undefined" || !document.referrer) {
    return undefined;
  }

  try {
    return new URL(document.referrer).hostname.replace(/^www\./u, "") || undefined;
  } catch {
    return undefined;
  }
};

/** UTM values from the current URL: trimmed, empty ones dropped, long ones cut to the limits. */
export const getUtmParams = (
  search: string = typeof window === "undefined" ? "" : window.location.search
): Pick<AnalyticsEventInput, "utmCampaign" | "utmMedium" | "utmSource"> => {
  try {
    const params = new URLSearchParams(search);
    const utmCampaign = cleanString(params.get("utm_campaign"), 160);
    const utmMedium = cleanString(params.get("utm_medium"), 120);
    const utmSource = cleanString(params.get("utm_source"), 120);

    return {
      ...(utmCampaign ? { utmCampaign } : {}),
      ...(utmMedium ? { utmMedium } : {}),
      ...(utmSource ? { utmSource } : {})
    };
  } catch {
    return {};
  }
};

/**
 * Keeps only contract-valid properties: string/finite number/boolean/null values, keys of 1–80
 * characters, strings cut to 500 characters, at most 40 keys and 4,000 characters in total.
 */
export const sanitizeAnalyticsProperties = (
  properties: unknown
): Record<string, AnalyticsPropertyValue> => {
  const sanitized: Record<string, AnalyticsPropertyValue> = {};

  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return sanitized;
  }

  let count = 0;
  let chars = 0;

  for (const [rawKey, rawValue] of Object.entries(properties as Record<string, unknown>)) {
    const key = rawKey.trim();

    if (!key || key.length > MAX_PROPERTY_KEY_LENGTH) {
      continue;
    }

    let value: AnalyticsPropertyValue;

    if (typeof rawValue === "string") {
      value = rawValue.slice(0, MAX_PROPERTY_STRING_LENGTH);
    } else if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) {
        continue;
      }
      value = rawValue;
    } else if (typeof rawValue === "boolean" || rawValue === null) {
      value = rawValue;
    } else {
      continue;
    }

    const cost =
      key.length + (typeof value === "string" ? value.length : NON_STRING_PROPERTY_CHARS);

    if (
      count >= MAX_ANALYTICS_EVENT_PROPERTY_COUNT ||
      chars + cost > MAX_ANALYTICS_EVENT_PROPERTIES_CHARS
    ) {
      continue;
    }

    sanitized[key] = value;
    count += 1;
    chars += cost;
  }

  return sanitized;
};

const OPTIONAL_FIELDS = [
  "appVersion",
  "browserName",
  "buildNumber",
  "correlationId",
  "deviceClass",
  "occurredAt",
  "osName",
  "referrerHostname",
  "requestId",
  "routeOrScreen",
  "utmCampaign",
  "utmMedium",
  "utmSource"
] as const satisfies ReadonlyArray<keyof AnalyticsEventInput>;

/**
 * Validates an event against the contract without ever throwing. Invalid optional fields are
 * dropped; an event whose name or properties are invalid is dropped entirely. Before the contract
 * has loaded (see {@link loadAnalyticsValidator}) the already-sanitized event passes through.
 */
export const validateAnalyticsEvent = (
  candidate: AnalyticsEventInput
): AnalyticsEventInput | null => {
  const schema = eventSchema;

  if (!schema) {
    return candidate;
  }

  try {
    const first = schema.safeParse(candidate);

    if (first.success) {
      return first.data;
    }

    const invalidOptional = new Set(
      first.error.issues
        .map((issue) => issue.path[0])
        .filter((field): field is (typeof OPTIONAL_FIELDS)[number] =>
          (OPTIONAL_FIELDS as readonly unknown[]).includes(field)
        )
    );

    if (invalidOptional.size > 0) {
      const repaired: Partial<AnalyticsEventInput> = { ...candidate };
      invalidOptional.forEach((field) => {
        delete repaired[field];
      });
      const second = schema.safeParse(repaired);

      if (second.success) {
        return second.data;
      }

      debug(`dropped invalid ${String(candidate.eventName)} event`, second.error.issues);
      return null;
    }

    debug(`dropped invalid ${String(candidate.eventName)} event`, first.error.issues);
    return null;
  } catch (error) {
    debug("dropped an event that could not be validated", error);
    return null;
  }
};

const getAnalyticsEndpoint = (): string => `${apiBaseUrl}/analytics/events`;

const getTransportHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  "x-linkdish-client-id": getStableClientId(),
  "x-linkdish-platform": "web_app"
});

const clearFlushTimer = (): void => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
};

const scheduleFlush = (): void => {
  if (flushTimer || queue.length === 0) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAnalytics();
  }, ANALYTICS_FLUSH_DELAY_MS);
};

const isOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;

const requeue = (events: AnalyticsEventInput[]): void => {
  const offline = isOffline();
  // Keep events while offline (flushed again on `online`); otherwise retry each event once.
  const retryable = events.filter((event) => offline || !retriedEvents.has(event));

  retryable.forEach((event) => retriedEvents.add(event));
  queue = [...retryable, ...queue].slice(0, MAX_QUEUE_SIZE);

  if (!offline) {
    scheduleFlush();
  }
};

const sendBatch = (queued: AnalyticsEventInput[], useBeacon: boolean): void => {
  // Retries are tracked on the queued objects, so keep each next to its validated form.
  const accepted: AnalyticsEventInput[] = [];
  const events: AnalyticsEventInput[] = [];

  for (const event of queued) {
    const validated = validateAnalyticsEvent(event);

    if (validated) {
      accepted.push(event);
      events.push(validated);
    }
  }

  if (events.length === 0) {
    return;
  }

  let body: string;

  try {
    body = JSON.stringify({ events });
  } catch (error) {
    debug("dropped a batch that could not be serialized", error);
    return;
  }

  const url = getAnalyticsEndpoint();

  if (useBeacon && transport.beacon(url, body)) {
    return;
  }

  try {
    transport
      .send(url, body, getTransportHeaders())
      .then((response) => {
        // Retry server hiccups and rate limits; a 4xx means the batch itself was rejected.
        if (response.status >= 500 || response.status === 429) {
          requeue(accepted);
        }
      })
      .catch(() => {
        requeue(accepted);
      });
  } catch {
    requeue(accepted);
  }
};

/** Sends everything queued now. `useBeacon` is for page hide/unload. Never throws. */
export function flushAnalytics(options: { useBeacon?: boolean } = {}): void {
  clearFlushTimer();

  if (!options.useBeacon && isOffline()) {
    return;
  }

  if (!options.useBeacon && !eventSchema && queue.length > 0) {
    // Validate before sending when there is time to load the contract (a page-hide flush can't
    // wait, so it sends the sanitized events as they are).
    void loadAnalyticsValidator().then(() => {
      flushAnalyticsNow(false);
    });
    return;
  }

  flushAnalyticsNow(options.useBeacon === true);
}

function flushAnalyticsNow(useBeacon: boolean): void {
  while (queue.length > 0) {
    sendBatch(queue.splice(0, ANALYTICS_MAX_BATCH_SIZE), useBeacon);
  }
}

const installLifecycle = (): void => {
  if (lifecycleInstalled || typeof window === "undefined") {
    return;
  }

  lifecycleInstalled = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushAnalytics({ useBeacon: true });
    }
  });
  window.addEventListener("pagehide", () => {
    flushAnalytics({ useBeacon: true });
  });
  window.addEventListener("online", () => {
    flushAnalytics();
  });
};

const enqueue = (event: AnalyticsEventInput): void => {
  installLifecycle();
  void loadAnalyticsValidator();
  queue.push(event);

  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(-MAX_QUEUE_SIZE);
  }

  if (queue.length >= ANALYTICS_MAX_BATCH_SIZE) {
    flushAnalytics();
    return;
  }

  scheduleFlush();
};

export const trackWebEvent = (event: WebAnalyticsEvent): void => {
  try {
    const requestId = cleanString(event.requestId, 120);
    const candidate: AnalyticsEventInput = {
      ...event,
      ...getUtmParams(),
      anonymousId: getWebAnalyticsClientId(),
      occurredAt: new Date().toISOString(),
      platform: "web_app",
      properties: sanitizeAnalyticsProperties(event.properties),
      referrerHostname: cleanString(event.referrerHostname, 240) ?? getReferrerHostname(),
      requestId:
        requestId && REQUEST_ID_PATTERN.test(requestId)
          ? requestId
          : `web:${createWebAnalyticsId()}`,
      routeOrScreen: cleanString(event.routeOrScreen, 240),
      sessionId: getWebAnalyticsSessionId()
    };

    // Drop keys whose value ended up undefined so optional fields stay truly optional.
    for (const key of Object.keys(candidate) as Array<keyof AnalyticsEventInput>) {
      if (candidate[key] === undefined) {
        delete candidate[key];
      }
    }

    enqueue(candidate);
  } catch (error) {
    debug("could not record an event", error);
  }
};

export const trackWebV2AnalyticsEvent = <EventName extends V2AnalyticsEvent["name"]>(
  event: V2AnalyticsEvent<EventName>
): void => {
  try {
    trackWebEvent({
      eventName: event.name,
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      ...(event.routeOrScreen ? { routeOrScreen: event.routeOrScreen } : {}),
      properties: event.properties
    });
  } catch (error) {
    debug("could not record an event", error);
  }
};

export type WebErrorSource = "error_boundary" | "unhandled_rejection" | "window_error";

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 160);
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim().slice(0, 160);
  }

  return "Unknown client error";
};

export const trackWebError = (
  error: unknown,
  routeOrScreen: string,
  source?: WebErrorSource
): void => {
  try {
    const message = describeError(error);
    const now = Date.now();
    const dedupeKey = `${routeOrScreen}\u0000${message}`;
    const lastSeen = recentErrors.get(dedupeKey);

    // A render loop can throw the same error hundreds of times; report it once per window.
    if (lastSeen !== undefined && now - lastSeen < ERROR_DEDUPE_WINDOW_MS) {
      return;
    }

    recentErrors.set(dedupeKey, now);

    if (recentErrors.size > 50) {
      const oldest = recentErrors.keys().next().value;
      if (oldest !== undefined) {
        recentErrors.delete(oldest);
      }
    }

    trackWebEvent({
      eventName: "client_error",
      routeOrScreen,
      properties: {
        message,
        ...(source ? { source } : {})
      }
    });
  } catch {
    // Error reporting must never cause another error.
  }
};

let webErrorTrackingInstalled = false;

export const installWebErrorTracking = (): void => {
  if (webErrorTrackingInstalled) {
    return;
  }

  webErrorTrackingInstalled = true;

  window.addEventListener("error", (event) => {
    trackWebError(event.error ?? event.message, window.location.pathname, "window_error");
  });

  window.addEventListener("unhandledrejection", (event) => {
    trackWebError(event.reason, window.location.pathname, "unhandled_rejection");
  });
};

/* ------------------------------------------------------------------------------------------------
 * Test seams
 * ---------------------------------------------------------------------------------------------- */

export function setAnalyticsTransportForTests(next: AnalyticsTransport | null): void {
  transport = next ?? baseTransport;
}

export function getQueuedAnalyticsEventsForTests(): readonly AnalyticsEventInput[] {
  return queue;
}

export function resetAnalyticsForTests(): void {
  clearFlushTimer();
  queue = [];
  recentErrors.clear();
  transport = baseTransport;
}
