import { render } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RouteAnalytics, resetRouteAnalyticsForTests } from "./RouteAnalytics";

const analyticsMocks = vi.hoisted(() => ({
  trackWebEvent: vi.fn()
}));

vi.mock("./client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent
}));

const eventNames = () =>
  analyticsMocks.trackWebEvent.mock.calls.map(
    (call) =>
      `${(call[0] as { eventName: string }).eventName} ${(call[0] as { routeOrScreen: string }).routeOrScreen}`
  );

let navigateTo: (path: string) => void = () => undefined;

const NavigateProbe: React.FC = () => {
  const navigate = useNavigate();
  navigateTo = (path) => {
    void navigate(path);
  };
  return null;
};

describe("RouteAnalytics", () => {
  beforeEach(() => {
    analyticsMocks.trackWebEvent.mockReset();
    resetRouteAnalyticsForTests();
  });

  it("reports the app load for a home landing, then route views", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <RouteAnalytics />
        <NavigateProbe />
      </MemoryRouter>
    );

    expect(eventNames()).toEqual(["web_app_loaded /"]);

    await React.act(async () => {
      navigateTo("/shopping");
      await Promise.resolve();
    });
    expect(eventNames()).toEqual(["web_app_loaded /", "web_route_viewed /shopping"]);
  });

  it("reports the app load for deep links too, keeping their route view", () => {
    render(
      <MemoryRouter initialEntries={["/import?url=https%3A%2F%2Fexample.com"]}>
        <RouteAnalytics />
      </MemoryRouter>
    );

    expect(eventNames()).toEqual(["web_app_loaded /import?...", "web_route_viewed /import?..."]);
  });
});
