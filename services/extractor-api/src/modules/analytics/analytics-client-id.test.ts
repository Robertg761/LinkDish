import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeAnalyticsClientId } from "./analytics-privacy";
import { registerAnalyticsRoutes } from "./routes/analytics-routes";

const mocks = vi.hoisted(() => ({
  writeAnalyticsEvents: vi.fn()
}));

vi.mock("./analytics-store.js", () => ({
  closeAnalyticsStore: vi.fn(),
  writeAnalyticsEvents: mocks.writeAnalyticsEvents
}));

vi.mock("../auth/auth-service.js", () => ({
  getAuthenticatedUser: vi.fn().mockResolvedValue(null)
}));

const buildAnalyticsApp = () => {
  const app = Fastify();
  registerAnalyticsRoutes(app);
  return app;
};

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

beforeEach(() => {
  mocks.writeAnalyticsEvents.mockResolvedValue(1);
});

afterEach(() => {
  vi.clearAllMocks();
});


const firstWrittenEvent = (): Record<string, unknown> | undefined => {
  const [firstCall] = mocks.writeAnalyticsEvents.mock.calls as Array<
    [Array<Record<string, unknown>>]
  >;

  return firstCall?.[0]?.[0];
};

describe("normalizeAnalyticsClientId", () => {
  it("accepts a canonical uuid and lowercases it", () => {
    expect(normalizeAnalyticsClientId("5D9A4B20-7E1F-4D5F-8FA2-838071CA35CB")).toBe(
      "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"
    );
  });

  it("rejects anything that is not a uuid", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "not-a-uuid",
      "'; drop table analytics_events; --",
      "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb-extra",
      "5d9a4b207e1f4d5f8fa2838071ca35cb"
    ]) {
      expect(normalizeAnalyticsClientId(value)).toBeUndefined();
    }
  });
});

describe("POST /analytics/events client identity", () => {
  it("drops a non-uuid x-linkdish-client-id header instead of sending it to Postgres", async () => {
    const app = buildAnalyticsApp();
    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      headers: {
        "x-linkdish-client-id": "not-a-uuid"
      },
      payload: eventBatch
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.writeAnalyticsEvents).toHaveBeenCalledOnce();
    expect(firstWrittenEvent()).not.toHaveProperty("anonymousId");
    await app.close();
  });

  it("keeps a valid uuid client id", async () => {
    const app = buildAnalyticsApp();
    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      headers: {
        "x-linkdish-client-id": "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"
      },
      payload: eventBatch
    });

    expect(response.statusCode).toBe(200);
    expect(firstWrittenEvent()).toMatchObject({
      anonymousId: "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"
    });
    await app.close();
  });

  it("does not 500 the whole batch when the analytics store write fails", async () => {
    mocks.writeAnalyticsEvents.mockRejectedValue(new Error("invalid input syntax for type uuid"));
    const app = buildAnalyticsApp();
    const response = await app.inject({
      method: "POST",
      url: "/analytics/events",
      payload: eventBatch
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 0 });
    await app.close();
  });
});
