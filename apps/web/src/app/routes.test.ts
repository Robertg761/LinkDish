import { describe, expect, it, vi } from "vitest";

import { preloadRouteForPath } from "./routes";

const loaded = vi.hoisted(() => [] as string[]);

vi.mock("../features/library/LibraryPage", () => {
  loaded.push("library");
  return { LibraryPage: () => null };
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
