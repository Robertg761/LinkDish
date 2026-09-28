import { beforeEach, describe, expect, it, vi } from "vitest";

import { flushMobileAnalytics, trackMobileEvent } from "./client";

import type { AnalyticsEventBatchRequest, AnalyticsEventInput } from "@linkdish/api-contracts";

const mocks = vi.hoisted(() => ({
  sendAnalyticsEvents:
    vi.fn<(request: AnalyticsEventBatchRequest) => Promise<{ accepted: number }>>(),
  storage: new Map<string, string>()
}));

vi.mock("@linkdish/api-client", () => ({
  createExtractorApiClient: () => ({
    sendAnalyticsEvents: mocks.sendAnalyticsEvents
  })
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(mocks.storage.get(key) ?? null)),
    removeItem: vi.fn((key: string) => {
      mocks.storage.delete(key);
      return Promise.resolve();
    }),
    setItem: vi.fn((key: string, value: string) => {
      mocks.storage.set(key, value);
      return Promise.resolve();
    })
  }
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      android: {
        versionCode: 205
      },
      version: "2.0.5"
    }
  }
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi
    .fn()
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
    .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
    .mockReturnValue("00000000-0000-4000-8000-000000000003")
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "android"
  }
}));

vi.mock("../config/env", () => ({
  mobileEnv: {
    apiBaseUrl: "https://api.example.com",
    useMockApi: false
  }
}));

describe("mobile analytics outbox", () => {
  beforeEach(async () => {
    await flushMobileAnalytics();
    mocks.storage.clear();
    mocks.sendAnalyticsEvents.mockReset();
    mocks.sendAnalyticsEvents.mockResolvedValue({ accepted: 1 });
  });

  it("serializes concurrent events without losing either payload", async () => {
    trackMobileEvent({
      eventName: "import_started",
      properties: {
        attempt: "primary",
        source_type: "url"
      }
    });
    trackMobileEvent({
      eventName: "android_extract_submitted",
      properties: {
        attempt: "primary",
        source_type: "url"
      }
    });

    await flushMobileAnalytics();

    const sentEvents: AnalyticsEventInput[] = mocks.sendAnalyticsEvents.mock.calls.flatMap(
      ([request]) => request.events
    );
    expect(sentEvents.map((event) => event.eventName)).toEqual([
      "import_started",
      "android_extract_submitted"
    ]);
    expect(new Set(sentEvents.map((event) => event.requestId)).size).toBe(2);
    expect(mocks.storage.has("linkdish.analytics.queue.v1")).toBe(false);
  });

  it("retains an unsent event and retries it with the next flush", async () => {
    mocks.sendAnalyticsEvents
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ accepted: 2 });

    trackMobileEvent({
      eventName: "import_started",
      properties: {
        attempt: "primary",
        source_type: "url"
      }
    });
    trackMobileEvent({
      eventName: "import_failed",
      properties: {
        attempt: "primary",
        failure_reason: "transport_error",
        source_type: "url"
      }
    });

    await flushMobileAnalytics();

    const retryBatch: AnalyticsEventInput[] | undefined =
      mocks.sendAnalyticsEvents.mock.calls.at(-1)?.[0].events;
    expect(retryBatch?.map((event) => event.eventName)).toEqual([
      "import_started",
      "import_failed"
    ]);
    expect(mocks.storage.has("linkdish.analytics.queue.v1")).toBe(false);
  });

  it("drops an invalid event instead of letting it block the queue", async () => {
    trackMobileEvent({
      eventName: "client_error",
      properties: {
        message: "x".repeat(600)
      }
    });
    trackMobileEvent({
      eventName: "import_started",
      properties: {
        attempt: "primary",
        source_type: "url"
      }
    });

    await flushMobileAnalytics();

    const sentEvents: AnalyticsEventInput[] = mocks.sendAnalyticsEvents.mock.calls.flatMap(
      ([request]) => request.events
    );
    expect(sentEvents.map((event) => event.eventName)).toEqual(["import_started"]);
    expect(mocks.storage.has("linkdish.analytics.queue.v1")).toBe(false);
  });

  it("drops invalid events that older builds left in the stored queue", async () => {
    mocks.sendAnalyticsEvents
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    trackMobileEvent({
      eventName: "import_started",
      properties: {
        attempt: "primary",
        source_type: "url"
      }
    });
    await flushMobileAnalytics().catch(() => undefined);

    const stored = JSON.parse(mocks.storage.get("linkdish.analytics.queue.v1") ?? "[]") as Array<
      Record<string, unknown>
    >;
    mocks.storage.set(
      "linkdish.analytics.queue.v1",
      JSON.stringify([{ ...stored[0], eventName: "retired_event_name" }, ...stored])
    );

    await flushMobileAnalytics();

    const lastBatch: AnalyticsEventInput[] | undefined =
      mocks.sendAnalyticsEvents.mock.calls.at(-1)?.[0].events;
    expect(lastBatch?.map((event) => event.eventName)).toEqual(["import_started"]);
    expect(mocks.storage.has("linkdish.analytics.queue.v1")).toBe(false);
  });

  it("drops a batch the API rejects outright rather than retrying it forever", async () => {
    mocks.sendAnalyticsEvents
      .mockRejectedValueOnce(Object.assign(new Error("Invalid request"), { statusCode: 400 }))
      .mockResolvedValue({ accepted: 1 });

    trackMobileEvent({
      eventName: "import_started",
      properties: {
        attempt: "primary",
        source_type: "url"
      }
    });
    await flushMobileAnalytics();

    expect(mocks.storage.has("linkdish.analytics.queue.v1")).toBe(false);

    trackMobileEvent({
      eventName: "import_failed",
      properties: {
        attempt: "primary",
        failure_reason: "transport_error",
        source_type: "url"
      }
    });
    await flushMobileAnalytics();

    const lastBatch: AnalyticsEventInput[] | undefined =
      mocks.sendAnalyticsEvents.mock.calls.at(-1)?.[0].events;
    expect(lastBatch?.map((event) => event.eventName)).toEqual(["import_failed"]);
  });
});
