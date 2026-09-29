import { describe, expect, it } from "vitest";

import { getAppRouteMeta } from "./app-route-meta";

describe("getAppRouteMeta", () => {
  it.each([
    ["/", "cookbook", true],
    ["/plan", "plan", true],
    ["/import", "add", true],
    ["/shopping", "shopping", true],
    ["/account", "you", true],
    ["/recipes/abc", "cookbook", false],
    ["/recipes/shared/abc", "cookbook", false],
    ["/featured/banana-bread", "cookbook", false],
    ["/household", "you", false],
    ["/pricing", "you", false],
    ["/settings", null, false]
  ])("classifies %s", (pathname, section, isDestination) => {
    const meta = getAppRouteMeta(pathname);

    expect(meta.section).toBe(section);
    expect(meta.isDestination).toBe(isDestination);
    expect(meta.title.length).toBeGreaterThan(0);
  });

  it("treats trailing slashes like the bare route", () => {
    expect(getAppRouteMeta("/shopping/").isDestination).toBe(true);
  });
});
