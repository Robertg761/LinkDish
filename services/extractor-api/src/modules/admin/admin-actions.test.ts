import { describe, expect, it, vi } from "vitest";

vi.mock("./admin-access.js", () => ({ recordAdminAction: vi.fn(() => Promise.resolve()) }));

const { removeAdminArchivedRecipe } = await import("./admin-actions.js");

describe("removeAdminArchivedRecipe", () => {
  it("records the removal before clearing the cache, then clears the cache again", async () => {
    const calls: string[] = [];
    const runtime = {
      recipeArchive: {
        read: () => Promise.resolve(null),
        isFresh: () => false,
        write: () => Promise.resolve(null),
        markRefreshFailed: () => Promise.resolve(),
        remove: vi.fn(() => {
          calls.push("archive");
          return Promise.resolve(true);
        })
      },
      extractionCache: {
        read: () => Promise.resolve(null),
        write: () => Promise.resolve(null),
        remove: vi.fn(() => {
          calls.push("cache");
          return Promise.resolve();
        })
      }
    };

    const result = await removeAdminArchivedRecipe(
      { actor: "admin", ip: "127.0.0.1" },
      runtime,
      "https://example.com/recipe",
      { cacheSettleMs: 0 }
    );

    expect(result).toEqual({
      url: "https://example.com/recipe",
      archiveConfigured: true,
      removedFromArchive: true
    });
    expect(calls).toEqual(["archive", "cache", "cache"]);
  });

  it("rejects something that is not an http(s) link", () => {
    expect(() =>
      removeAdminArchivedRecipe({ actor: "admin", ip: "127.0.0.1" }, {}, "ftp://example.com/x")
    ).toThrow("Pass the recipe link");
  });
});
