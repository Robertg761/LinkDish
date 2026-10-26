import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_RECIPES } from "../packages/recipe-domain/src/samples.js";

import type * as HouseholdModule from "./household.js";

/* The library routes are served by the household function (see vercel.json). */
let libraryApi: typeof HouseholdModule;

const authMocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn()
}));

vi.mock("../services/extractor-api/src/modules/auth/auth-service.js", () => ({
  getAuthenticatedUser: authMocks.getAuthenticatedUser
}));

const user = {
  email: "cook@example.com",
  id: "user_cook"
};

const request = (path: string, init?: RequestInit & { search?: string }) =>
  new Request(
    `https://api.linkdish.ca/api/household?path=${encodeURIComponent(`library/${path}`)}${init?.search ?? ""}`,
    {
      headers: {
        authorization: "Bearer header.payload.signature",
        "content-type": "application/json",
        origin: "https://app.linkdish.ca"
      },
      ...init
    }
  );

const recipeChange = (id: string, updatedAt: string) => ({
  id,
  kind: "recipe",
  recipe: {
    createdAt: "2026-10-01T12:00:00.000Z",
    fetchMode: "http",
    provenance: ["jsonld"],
    recipe: SAMPLE_RECIPES[0].recipe,
    strategy: "recipe-schema",
    warnings: []
  },
  updatedAt
});

const loadApi = async (env: Record<string, string> = {}) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    LIBRARY_SYNC_ENABLED: "true",
    NODE_ENV: "test",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: "https://upstash.invalid",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  libraryApi = await import("./household.js");
};

beforeEach(async () => {
  authMocks.getAuthenticatedUser.mockReset();
  authMocks.getAuthenticatedUser.mockResolvedValue({ user });
  await loadApi();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Vercel library adapter", () => {
  it("stores pushed changes and pulls them back from a cursor", async () => {
    const pushed = await libraryApi.POST(
      request("changes", {
        body: JSON.stringify({
          changes: [
            recipeChange("recipe_a", "2026-10-26T10:00:00.000Z"),
            recipeChange("recipe_b", "2026-10-26T10:00:00.000Z")
          ]
        }),
        method: "POST"
      })
    );

    expect(pushed.status).toBe(200);
    expect(pushed.headers.get("access-control-allow-origin")).toBe("https://app.linkdish.ca");
    await expect(pushed.json()).resolves.toEqual({
      accepted: [
        { id: "recipe_a", kind: "recipe" },
        { id: "recipe_b", kind: "recipe" }
      ],
      newer: [],
      rejected: []
    });

    const everything = await libraryApi.GET(request("changes"));

    expect(everything.status).toBe(200);
    expect(everything.headers.get("cache-control")).toBe("no-store");
    await expect(everything.json()).resolves.toMatchObject({
      changes: [{ id: "recipe_a" }, { id: "recipe_b" }],
      cursor: "2",
      hasMore: false
    });

    const sinceFirst = await libraryApi.GET(request("changes", { search: "&since=1" }));
    await expect(sinceFirst.json()).resolves.toMatchObject({
      changes: [{ id: "recipe_b" }],
      cursor: "2"
    });
  });

  it("rejects a malformed cursor or envelope", async () => {
    const badCursor = await libraryApi.GET(request("changes", { search: "&since=abc" }));
    expect(badCursor.status).toBe(400);

    const notJson = await libraryApi.POST(
      request("changes", { body: "{not json", method: "POST" })
    );
    expect(notJson.status).toBe(400);
    await expect(notJson.json()).resolves.toEqual({
      message: "Request body must be valid JSON."
    });

    const tooMany = await libraryApi.POST(
      request("changes", {
        body: JSON.stringify({
          changes: Array.from({ length: 26 }, (_, index) =>
            recipeChange(`recipe_${index}`, "2026-10-26T10:00:00.000Z")
          )
        }),
        method: "POST"
      })
    );
    expect(tooMany.status).toBe(400);
  });

  it("requires a signed-in account", async () => {
    authMocks.getAuthenticatedUser.mockResolvedValue(null);

    const response = await libraryApi.GET(request("changes"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ message: "Sign in is required." });
  });

  it("answers 404 for other paths and while sync is switched off", async () => {
    expect((await libraryApi.GET(request("recipes"))).status).toBe(404);

    await loadApi({ LIBRARY_SYNC_ENABLED: "false" });

    const off = await libraryApi.GET(request("changes"));
    expect(off.status).toBe(404);
    await expect(off.json()).resolves.toEqual({ message: "LinkDish cloud sync is not enabled." });
    expect(authMocks.getAuthenticatedUser).not.toHaveBeenCalled();
  });
});
