import { createExtractorApiClient } from "@linkdish/api-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { mobileEnv } from "../config/env";

import type { AnalyticsEventInput, AnalyticsEventName } from "@linkdish/api-contracts";

type MobileAnalyticsEvent = Omit<
  AnalyticsEventInput,
  "anonymousId" | "appVersion" | "buildNumber" | "eventName" | "platform" | "sessionId"
> & {
  eventName: AnalyticsEventName;
};

const INSTALL_ID_KEY = "linkdish.analytics.installId.v1";
const SESSION_ID_KEY = "linkdish.analytics.sessionId.v1";
const SESSION_LAST_SEEN_KEY = "linkdish.analytics.sessionLastSeen.v1";
const FIRST_OPEN_KEY = "linkdish.analytics.firstOpenTracked.v1";
const QUEUE_KEY = "linkdish.analytics.queue.v1";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_QUEUE_SIZE = 50;
const MAX_BATCH_SIZE = 25;

const apiClient = createExtractorApiClient({
  baseUrl: mobileEnv.apiBaseUrl
});

export const createMobileAnalyticsId = (): string =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });

const getStoredOrCreate = async (key: string): Promise<string> => {
  const existing = await AsyncStorage.getItem(key);

  if (existing) {
    return existing;
  }

  const next = createMobileAnalyticsId();
  await AsyncStorage.setItem(key, next);
  return next;
};

export const getMobileAnalyticsInstallId = (): Promise<string> => getStoredOrCreate(INSTALL_ID_KEY);

export const getMobileAnalyticsSessionId = async (): Promise<string> => {
  const now = Date.now();
  const lastSeen = Number(await AsyncStorage.getItem(SESSION_LAST_SEEN_KEY));
  let sessionId = await AsyncStorage.getItem(SESSION_ID_KEY);

  if (!sessionId || !Number.isFinite(lastSeen) || now - lastSeen > SESSION_TIMEOUT_MS) {
    sessionId = createMobileAnalyticsId();
    await AsyncStorage.setItem(SESSION_ID_KEY, sessionId);
  }

  await AsyncStorage.setItem(SESSION_LAST_SEEN_KEY, String(now));
  return sessionId;
};

const getNativeBuildNumber = (): string | undefined =>
  Platform.OS === "ios"
    ? Constants.expoConfig?.ios?.buildNumber
    : Constants.expoConfig?.android?.versionCode?.toString();

export const getMobileAnalyticsHeaders = async (): Promise<Record<string, string>> => {
  const appVersion = Constants.expoConfig?.version;
  const buildNumber = getNativeBuildNumber();

  return {
    "x-linkdish-client-id": await getMobileAnalyticsInstallId(),
    "x-linkdish-platform": "android_app",
    "x-linkdish-session-id": await getMobileAnalyticsSessionId(),
    ...(appVersion ? { "x-linkdish-app-version": appVersion } : {}),
    ...(buildNumber ? { "x-linkdish-build-number": buildNumber } : {})
  };
};

const readQueue = async (): Promise<AnalyticsEventInput[]> => {
  const rawQueue = await AsyncStorage.getItem(QUEUE_KEY);

  if (!rawQueue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawQueue) as unknown;
    return Array.isArray(parsed) ? (parsed as AnalyticsEventInput[]) : [];
  } catch {
    return [];
  }
};

const writeQueue = async (events: AnalyticsEventInput[]): Promise<void> => {
  if (events.length === 0) {
    await AsyncStorage.removeItem(QUEUE_KEY);
    return;
  }

  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(events.slice(-MAX_QUEUE_SIZE)));
};

let queueOperation: Promise<void> = Promise.resolve();

const serializeQueueOperation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
  const result = queueOperation.then(operation, operation);
  queueOperation = result.then(
    () => undefined,
    () => undefined
  );
  return result;
};

const flushQueuedEvents = async (): Promise<void> => {
  let events = await readQueue();

  if (events.length === 0 || mobileEnv.useMockApi) {
    return;
  }

  while (events.length > 0) {
    const batch = events.slice(0, MAX_BATCH_SIZE);
    await apiClient.sendAnalyticsEvents({ events: batch });
    events = events.slice(batch.length);
    await writeQueue(events);
  }
};

export const flushMobileAnalytics = (): Promise<void> => serializeQueueOperation(flushQueuedEvents);

export const trackMobileEvent = (event: MobileAnalyticsEvent): void => {
  void serializeQueueOperation(async () => {
    const payload: AnalyticsEventInput = {
      ...event,
      anonymousId: await getMobileAnalyticsInstallId(),
      appVersion: Constants.expoConfig?.version ?? undefined,
      buildNumber: getNativeBuildNumber(),
      occurredAt: new Date().toISOString(),
      osName: Platform.OS,
      platform: "android_app",
      requestId: event.requestId ?? `android:${createMobileAnalyticsId()}`,
      sessionId: await getMobileAnalyticsSessionId()
    };

    const nextQueue = [...(await readQueue()), payload].slice(-MAX_QUEUE_SIZE);
    await writeQueue(nextQueue);
    await flushQueuedEvents();
  }).catch(() => {
    // Analytics should never affect app behavior.
  });
};

export const trackMobileAppOpened = (): void => {
  void (async () => {
    const hasTrackedFirstOpen = (await AsyncStorage.getItem(FIRST_OPEN_KEY)) === "true";

    if (!hasTrackedFirstOpen) {
      await AsyncStorage.setItem(FIRST_OPEN_KEY, "true");
      trackMobileEvent({
        eventName: "android_first_open",
        routeOrScreen: "root",
        properties: {}
      });
    }

    trackMobileEvent({
      eventName: "android_app_opened",
      routeOrScreen: "root",
      properties: {}
    });
  })().catch(() => {
    // Analytics should never affect app behavior.
  });
};

let mobileErrorTrackingInstalled = false;

export const installMobileErrorTracking = (): void => {
  if (mobileErrorTrackingInstalled) {
    return;
  }

  mobileErrorTrackingInstalled = true;

  const errorUtils = (
    globalThis as typeof globalThis & {
      ErrorUtils?: {
        getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
        setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
      };
    }
  ).ErrorUtils;
  const previousHandler = errorUtils?.getGlobalHandler?.();

  errorUtils?.setGlobalHandler?.((error, isFatal) => {
    trackMobileEvent({
      eventName: "client_error",
      routeOrScreen: "native",
      properties: {
        fatal: Boolean(isFatal),
        message: error.message.slice(0, 160)
      }
    });
    previousHandler?.(error, isFatal);
  });
};
