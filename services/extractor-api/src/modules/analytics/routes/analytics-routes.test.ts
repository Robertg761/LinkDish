import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../../app";

import type { ExtractorRuntime } from "../../extract/types";

/**
 * POST /analytics/events through the whole Fastify app (CORS, rate limit and body limit
 * included). The web client flushes on page hide with `navigator.sendBeacon`, which posts the
 * JSON batch as `text/plain;charset=UTF-8` so the request stays CORS-simple (no preflight).
 */

const mocks = vi.hoisted(() => ({
  writeAnalyticsEvents: vi.fn()
}));

vi.mock("../analytics-store.js", () => ({
  closeAnalyticsStore: vi.fn(() => Promise.resolve()),
  writeAnalyticsEvents: mocks.writeAnalyticsEvents
}));

vi.mock("../../auth/auth-service.js", () => ({
  getAuthenticatedUser: vi.fn().mockResolvedValue(null)
}));

const webOrigin = "https://app.linkdish.ca";
const beaconContentType = "text/plain;charset=UTF-8";

const eventBatch = {
  events: [
    {
      eventName: "web_route_viewed",
      occurredAt: "2026-07-11T12:00:00.000Z",
      platform: "web_app",
      properties: {}
    }
  ]
};

/* The analytics route never touches the extractor runtime; closing the app disposes it. */
const stubRuntime = {
  dispose: () => Promise.resolve()
} as unknown as ExtractorRuntime;

const postBeacon = async (payload: string) => {
  const app = buildApp({ runtime: stubRuntime });

  try {
    return await app.inject({
      headers: {
        "content-type": beaconContentType,
        origin: webOrigin
      },
      method: "POST",
      payload,
      url: "/analytics/events"
    });
  } finally {
    await app.close();
  }
};

beforeEach(() => {
  mocks.writeAnalyticsEvents.mockResolvedValue(1);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /analytics/events with a sendBeacon (text/plain) body", () => {
  it("parses the JSON text and writes the batch", async () => {
    const response = await postBeacon(JSON.stringify(eventBatch));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(mocks.writeAnalyticsEvents).toHaveBeenCalledOnce();
    expect(mocks.writeAnalyticsEvents.mock.calls[0]?.[0]).toMatchObject([
      { eventName: "web_route_viewed", platform: "web_app" }
    ]);
  });

  it("keeps the CORS headers on the simple (no preflight) beacon request", async () => {
    const response = await postBeacon(JSON.stringify(eventBatch));

    expect(response.headers["access-control-allow-origin"]).toBe(webOrigin);
  });

  it("answers 400 without writing when the text is not JSON", async () => {
    const response = await postBeacon("{not json");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: "Invalid analytics event batch." });
    expect(mocks.writeAnalyticsEvents).not.toHaveBeenCalled();
  });

  it("answers 400 without writing when the JSON text is not a batch", async () => {
    for (const payload of ["", "null", '"a string"', "[]", JSON.stringify({ events: [] })]) {
      const response = await postBeacon(payload);

      expect(response.statusCode, payload).toBe(400);
    }

    expect(mocks.writeAnalyticsEvents).not.toHaveBeenCalled();
  });

  it("still applies the body size limit to text bodies", async () => {
    const response = await postBeacon(" ".repeat(8 * 1024 * 1024 + 1));

    expect(response.statusCode).toBe(413);
    expect(mocks.writeAnalyticsEvents).not.toHaveBeenCalled();
  });

  it("still accepts an application/json batch", async () => {
    const app = buildApp({ runtime: stubRuntime });

    try {
      const response = await app.inject({
        headers: { origin: webOrigin },
        method: "POST",
        payload: eventBatch,
        url: "/analytics/events"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: 1, dropped: 0 });
    } finally {
      await app.close();
    }
  });
});
