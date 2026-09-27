import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANALYTICS_FLUSH_DELAY_MS,
  flushAnalytics,
  getQueuedAnalyticsEventsForTests,
  getUtmParams,
  loadAnalyticsValidator,
  resetAnalyticsForTests,
  sanitizeAnalyticsProperties,
  setAnalyticsTransportForTests,
  trackWebError,
  trackWebEvent,
  trackWebV2AnalyticsEvent,
  validateAnalyticsEvent,
  type AnalyticsTransport
} from "./client";

import type { AnalyticsEventInput } from "@linkdish/api-contracts";

const createTransport = (options: { beacon?: boolean; status?: number } = {}) => {
  const transport = {
    beacon: vi.fn<AnalyticsTransport["beacon"]>(() => options.beacon ?? true),
    send: vi.fn<AnalyticsTransport["send"]>(() =>
      Promise.resolve(new Response(null, { status: options.status ?? 200 }))
    )
  };
  setAnalyticsTransportForTests(transport);
  return transport;
};

const sentEvents = (transport: ReturnType<typeof createTransport>, call = 0) =>
  (JSON.parse(transport.send.mock.calls[call]![1]) as { events: AnalyticsEventInput[] }).events;

const track = (index = 0) =>
  trackWebEvent({
    eventName: "web_route_viewed",
    routeOrScreen: "/",
    properties: { route: "/", index }
  });

describe("analytics client", () => {
  beforeEach(async () => {
    await loadAnalyticsValidator();
    resetAnalyticsForTests();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetAnalyticsForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("batches events and sends them five seconds after the first one", () => {
    vi.useFakeTimers();
    const transport = createTransport();

    track(1);
    track(2);
    expect(transport.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ANALYTICS_FLUSH_DELAY_MS);

    expect(transport.send).toHaveBeenCalledTimes(1);
    const [url, , headers] = transport.send.mock.calls[0]!;
    expect(url).toMatch(/\/analytics\/events$/u);
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-linkdish-client-id": expect.any(String) as string,
      "x-linkdish-platform": "web_app"
    });
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("authorization");
    expect(sentEvents(transport).map((event) => event.properties)).toEqual([
      { index: 1, route: "/" },
      { index: 2, route: "/" }
    ]);
    expect(sentEvents(transport)[0]).toMatchObject({
      eventName: "web_route_viewed",
      platform: "web_app",
      routeOrScreen: "/"
    });
  });

  it("sends immediately once 25 events are waiting", () => {
    const transport = createTransport();

    for (let index = 0; index < 26; index += 1) {
      track(index);
    }

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(sentEvents(transport)).toHaveLength(25);
    expect(getQueuedAnalyticsEventsForTests()).toHaveLength(1);
  });

  it("uses sendBeacon when the page is hidden and falls back to fetch", () => {
    const transport = createTransport();
    track(1);

    window.dispatchEvent(new Event("pagehide"));

    expect(transport.beacon).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
    expect(getQueuedAnalyticsEventsForTests()).toHaveLength(0);

    transport.beacon.mockReturnValue(false);
    track(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    expect(transport.beacon).toHaveBeenCalledTimes(2);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("never throws for bad UTM values and trims them to the contract", () => {
    const transport = createTransport();
    window.history.replaceState(
      null,
      "",
      `/?utm_source=&utm_medium=%20%20email%20&utm_campaign=${"x".repeat(300)}`
    );

    expect(() => track()).not.toThrow();
    flushAnalytics();

    const [event] = sentEvents(transport);
    expect(event).not.toHaveProperty("utmSource");
    expect(event?.utmMedium).toBe("email");
    expect(event?.utmCampaign).toHaveLength(160);
  });

  it("drops invalid events without throwing and repairs invalid optional fields", () => {
    const transport = createTransport();

    expect(() =>
      trackWebEvent({ eventName: "not_a_real_event" as never, properties: {} })
    ).not.toThrow();
    trackWebEvent({
      correlationId: "not-a-uuid",
      eventName: "recipe_opened",
      properties: { surface: "recipe_detail" },
      requestId: "has spaces!"
    });
    flushAnalytics();

    const events = sentEvents(transport);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("correlationId");
    expect(events[0]?.requestId).toMatch(/^web:/u);
    expect(console.debug).toHaveBeenCalled();
  });

  it("keeps only contract-valid properties", () => {
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`k${index}`, index]));

    expect(
      sanitizeAnalyticsProperties({
        "": "empty key",
        [`${"k".repeat(81)}`]: "long key",
        infinite: Number.POSITIVE_INFINITY,
        long: "y".repeat(600),
        nested: { a: 1 },
        nothing: undefined,
        ok: true,
        zero: 0,
        nil: null
      })
    ).toEqual({ long: "y".repeat(500), nil: null, ok: true, zero: 0 });
    expect(Object.keys(sanitizeAnalyticsProperties(many))).toHaveLength(40);
    expect(sanitizeAnalyticsProperties("nope")).toEqual({});
  });

  it("retries a failed batch once", async () => {
    const transport = createTransport();
    transport.send.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.useFakeTimers();

    track(1);
    flushAnalytics();
    await vi.runAllTimersAsync();

    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(getQueuedAnalyticsEventsForTests()).toHaveLength(0);
  });

  it("forwards typed V2 events and reports each distinct error once per window", () => {
    const transport = createTransport();

    trackWebV2AnalyticsEvent({ name: "recipe_opened", properties: { surface: "shared_link" } });
    trackWebError(new Error("boom"), "/recipes/:id", "error_boundary");
    trackWebError(new Error("boom"), "/recipes/:id", "error_boundary");
    trackWebError("string failure", "/");
    flushAnalytics();

    const events = sentEvents(transport);
    expect(events.map((event) => event.eventName)).toEqual([
      "recipe_opened",
      "client_error",
      "client_error"
    ]);
    expect(events[1]?.properties).toEqual({ message: "boom", source: "error_boundary" });
    expect(events[2]?.properties).toEqual({ message: "string failure" });
  });

  it("waits for the lazily loaded contract before a regular flush", async () => {
    vi.resetModules();
    const fresh = await import("./client");
    const transport = {
      beacon: vi.fn(() => true),
      send: vi.fn(() => Promise.resolve(new Response(null, { status: 200 })))
    };
    fresh.setAnalyticsTransportForTests(transport);

    fresh.trackWebEvent({ eventName: "definitely_not_an_event" as never, properties: {} });
    fresh.trackWebEvent({ eventName: "web_app_loaded", properties: { route: "/" } });
    fresh.flushAnalytics();

    expect(transport.send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledTimes(1));
    const body = JSON.parse((transport.send.mock.calls[0] as unknown as [string, string])[1]) as {
      events: AnalyticsEventInput[];
    };
    expect(body.events.map((event) => event.eventName)).toEqual(["web_app_loaded"]);
    fresh.resetAnalyticsForTests();
  });

  it("parses UTM params safely", () => {
    expect(getUtmParams("?utm_source=site&utm_medium=")).toEqual({ utmSource: "site" });
    expect(getUtmParams("")).toEqual({});
  });

  it("validates a single event without throwing", () => {
    expect(
      validateAnalyticsEvent({ eventName: "web_app_loaded", platform: "web_app", properties: {} })
    ).toMatchObject({ eventName: "web_app_loaded" });
    expect(validateAnalyticsEvent({ eventName: "nope" } as never)).toBeNull();
  });
});
