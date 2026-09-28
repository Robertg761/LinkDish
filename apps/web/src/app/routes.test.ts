import { describe, expect, it, vi } from "vitest";

import { preloadRouteForPath, warmRouteDataForPath } from "./routes";

const loaded = vi.hoisted(() => [] as string[]);
const warmCookbook = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("../features/library/LibraryPage", () => {
  loaded.push("library");
  return { LibraryPage: () => null, warmCookbook };
});
vi.mock("../features/library/RecipePage", () => {
  loaded.push("recipe");
  return { RecipePage: () => null };
});
vi.mock("../features/shopping/ShoppingListPage", () => {
  loaded.push("shopping");
  return { ShoppingListPage: () => null };
});

describe("preloadRouteForPath", () => {
  it("starts loading the landing page's chunk", async () => {
    await preloadRouteForPath("/");
    await preloadRouteForPath("/recipes/abc/");
    await preloadRouteForPath("/shopping");

    expect(loaded).toEqual(["library", "recipe", "shopping"]);
  });

  it("returns null for routes without a boot preload", () => {
    expect(preloadRouteForPath("/privacy")).toBeNull();
    expect(preloadRouteForPath("/sso-callback")).toBeNull();
  });
});

describe("warmRouteDataForPath", () => {
  it("starts reading the Cookbook's recipes when the visit lands on it", async () => {
    await warmRouteDataForPath("/");
    await warmRouteDataForPath("/library/");

    expect(warmCookbook).toHaveBeenCalledTimes(2);
  });

  it("reads nothing ahead for other routes", () => {
    expect(warmRouteDataForPath("/recipes/abc")).toBeNull();
    expect(warmRouteDataForPath("/shopping")).toBeNull();
  });
});
