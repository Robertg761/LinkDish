import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as HouseholdModule from "./household.js";
import type * as HouseholdServiceModule from "../services/extractor-api/src/modules/households/household-service.js";

type HouseholdApi = typeof HouseholdModule;
type HouseholdService = typeof HouseholdServiceModule;

let householdApi: HouseholdApi;

const authMocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn()
}));

const householdMocks = vi.hoisted(() => ({
  deleteShoppingItemsForUser: vi.fn(),
  getHouseholdShoppingListForUser: vi.fn(),
  upsertShoppingItemsForUser: vi.fn()
}));

vi.mock("../services/extractor-api/src/modules/auth/auth-service.js", () => ({
  getAuthenticatedUser: authMocks.getAuthenticatedUser
}));

vi.mock("../services/extractor-api/src/modules/households/household-service.js", async () => {
  const actual = await vi.importActual<HouseholdService>(
    "../services/extractor-api/src/modules/households/household-service.js"
  );

  return {
    ...actual,
    deleteShoppingItemsForUser: householdMocks.deleteShoppingItemsForUser,
    getHouseholdShoppingListForUser: householdMocks.getHouseholdShoppingListForUser,
    upsertShoppingItemsForUser: householdMocks.upsertShoppingItemsForUser
  };
});

const user = {
  email: "member@example.com",
  id: "user_member"
};

const request = (path: string, init?: RequestInit) =>
  new Request(`https://api.linkdish.ca/api/household?path=${encodeURIComponent(path)}`, {
    headers: {
      authorization: "Bearer header.payload.signature",
      "content-type": "application/json"
    },
    ...init
  });

const buildShoppingItem = (updatedAt: string, overrides: Record<string, unknown> = {}) => ({
  addedBy: "user_member",
  checked: false,
  checkedBy: null,
  id: "shopping_item_1",
  recipeId: null,
  recipeTitle: null,
  section: null,
  text: "olive oil",
  unit: null,
  updatedAt,
  ...overrides
});

beforeEach(async () => {
  vi.resetModules();
  authMocks.getAuthenticatedUser.mockReset();
  householdMocks.deleteShoppingItemsForUser.mockReset();
  householdMocks.getHouseholdShoppingListForUser.mockReset();
  householdMocks.upsertShoppingItemsForUser.mockReset();
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("HOUSEHOLDS_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "test");
  authMocks.getAuthenticatedUser.mockResolvedValue({
    user
  });
  householdMocks.getHouseholdShoppingListForUser.mockResolvedValue({
    items: [buildShoppingItem("2026-07-04T12:00:00.000Z")]
  });
  householdMocks.upsertShoppingItemsForUser.mockResolvedValue({
    ignored: [],
    items: [buildShoppingItem("2026-07-04T12:01:00.000Z")]
  });
  householdMocks.deleteShoppingItemsForUser.mockResolvedValue({
    deletedItemIds: ["shopping_item_1"],
    ignored: [],
    status: "deleted"
  });

  householdApi = await import("./household.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Vercel household shopping adapter", () => {
  it("dispatches GET /household/shopping to the shopping list service", async () => {
    const response = await householdApi.GET(request("shopping"));

    expect(response.status).toBe(200);
    expect(householdMocks.getHouseholdShoppingListForUser).toHaveBeenCalledWith(user);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          id: "shopping_item_1",
          text: "olive oil"
        }
      ]
    });
  });

  it("dispatches PUT /household/shopping/items with validated item payloads", async () => {
    const item = buildShoppingItem("2026-07-04T12:01:00.000Z", {
      checked: true,
      checkedBy: "user_member"
    });

    const response = await householdApi.PUT(
      request("shopping/items", {
        body: JSON.stringify({
          items: [item]
        }),
        method: "PUT"
      })
    );

    expect(response.status).toBe(200);
    expect(householdMocks.upsertShoppingItemsForUser).toHaveBeenCalledWith(user, {
      items: [item]
    });
    await expect(response.json()).resolves.toMatchObject({
      ignored: [],
      items: [
        {
          id: "shopping_item_1"
        }
      ]
    });
  });

  it("returns item-level LWW ignored updates from PUT /household/shopping/items", async () => {
    householdMocks.upsertShoppingItemsForUser.mockResolvedValue({
      ignored: [
        {
          existingUpdatedAt: "2026-07-04T12:00:00.000Z",
          id: "shopping_item_1",
          reason: "older_update"
        }
      ],
      items: [buildShoppingItem("2026-07-04T12:00:00.000Z")]
    });

    const response = await householdApi.PUT(
      request("shopping/items", {
        body: JSON.stringify({
          items: [buildShoppingItem("2026-07-04T11:59:00.000Z")]
        }),
        method: "PUT"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ignored: [
        {
          existingUpdatedAt: "2026-07-04T12:00:00.000Z",
          id: "shopping_item_1",
          reason: "older_update"
        }
      ]
    });
  });

  it("dispatches DELETE /household/shopping/items with validated delete payloads", async () => {
    const response = await householdApi.DELETE(
      request("shopping/items", {
        body: JSON.stringify({
          items: [
            {
              id: "shopping_item_1",
              updatedAt: "2026-07-04T12:02:00.000Z"
            }
          ]
        }),
        method: "DELETE"
      })
    );

    expect(response.status).toBe(200);
    expect(householdMocks.deleteShoppingItemsForUser).toHaveBeenCalledWith(user, {
      items: [
        {
          id: "shopping_item_1",
          updatedAt: "2026-07-04T12:02:00.000Z"
        }
      ]
    });
    await expect(response.json()).resolves.toEqual({
      deletedItemIds: ["shopping_item_1"],
      ignored: [],
      status: "deleted"
    });
  });

  it("surfaces membership-denied errors from the shared shopping service", async () => {
    householdMocks.getHouseholdShoppingListForUser.mockRejectedValue(
      Object.assign(new Error("An active LinkDish Family household is required."), {
        statusCode: 403
      })
    );

    const response = await householdApi.GET(request("shopping"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "An active LinkDish Family household is required."
    });
  });
});
