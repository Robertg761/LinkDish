import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountUser } from "../../../../../packages/api-contracts/src/index.js";

/*
 * A minimal Upstash REST fake (the /multi-exec endpoint and the commands the
 * household shopping list uses) that counts HTTP round trips, so the tests can
 * prove list reads and batch writes no longer cost one request per item.
 */
const createFakeUpstash = () => {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  let requestCount = 0;

  const run = (command: string[]): { error?: string; result?: unknown } => {
    const [name = "", key = "", ...args] = command;

    switch (name.toUpperCase()) {
      case "GET":
        return { result: strings.get(key) ?? null };
      case "SET": {
        if (args.slice(1).some((arg) => arg.toUpperCase() === "NX") && strings.has(key)) {
          return { result: null };
        }

        strings.set(key, args[0] ?? "");
        return { result: "OK" };
      }
      case "DEL": {
        let removed = 0;

        for (const deleteKey of [key, ...args]) {
          removed += strings.delete(deleteKey) ? 1 : 0;
          removed += sets.delete(deleteKey) ? 1 : 0;
        }

        return { result: removed };
      }
      case "SADD": {
        const set = sets.get(key) ?? new Set<string>();
        args.forEach((member) => set.add(member));
        sets.set(key, set);
        return { result: args.length };
      }
      case "SREM":
        args.forEach((member) => sets.get(key)?.delete(member));
        return { result: args.length };
      case "SMEMBERS":
        return { result: [...(sets.get(key) ?? [])] };
      case "EVAL": {
        /* Only the household lock release script: EVAL script 1 key value. */
        const lockKey = args[1] ?? "";
        const lockValue = args[2];

        if (strings.get(lockKey) === lockValue) {
          strings.delete(lockKey);
          return { result: 1 };
        }

        return { result: 0 };
      }
      default:
        return { error: `Unsupported fake command ${name}` };
    }
  };

  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://upstash.test/multi-exec") {
      requestCount += 1;
      const commands = JSON.parse(typeof init?.body === "string" ? init.body : "[]") as string[][];
      return Promise.resolve(Response.json(commands.map(run)));
    }

    if (url.startsWith("https://api.revenuecat.com/")) {
      return Promise.resolve(
        Response.json({
          subscriber: { entitlements: { Family: { expires_date: null } } }
        })
      );
    }

    return Promise.reject(new Error(`Unexpected fetch ${url}`));
  });

  return {
    fetchMock,
    requestCount: () => requestCount,
    strings,
    sets
  };
};

const owner: AccountUser = {
  createdAt: "2026-07-01T00:00:00.000Z",
  email: "owner@example.com",
  id: "user_owner",
  updatedAt: "2026-07-01T00:00:00.000Z"
} as AccountUser;

const shoppingItem = (id: string, updatedAt = "2026-07-04T12:00:00.000Z") => ({
  addedBy: owner.id,
  checked: false,
  checkedBy: null,
  id,
  recipeId: null,
  recipeTitle: null,
  section: null,
  text: `item ${id}`,
  unit: null,
  updatedAt
});

const importWithFakeUpstash = async () => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    REVENUECAT_FAMILY_ENTITLEMENT_ID: "Family",
    REVENUECAT_PLUS_ENTITLEMENT_ID: "Plus",
    REVENUECAT_SECRET_API_KEY: "test_revenuecat_secret",
    UPSTASH_REDIS_REST_TOKEN: "test-token",
    UPSTASH_REDIS_REST_URL: "https://upstash.test"
  })) {
    vi.stubEnv(key, value);
  }

  const upstash = createFakeUpstash();
  vi.stubGlobal("fetch", upstash.fetchMock);

  upstash.strings.set("linkdish:household-by-user:v1:user_owner", "household_1");
  upstash.strings.set(
    "linkdish:household:v1:household_1",
    JSON.stringify({
      id: "household_1",
      ownerUserId: owner.id,
      memberUserIds: [owner.id],
      cooldownSlots: [],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    })
  );

  return { households: await import("./household-service.js"), upstash };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("household shopping list store round trips", () => {
  it("reads the shopping list in a fixed number of requests however long it is", async () => {
    const { households, upstash } = await importWithFakeUpstash();

    await households.upsertShoppingItemsForUser(owner, { items: [shoppingItem("item_0")] });
    const beforeShortList = upstash.requestCount();
    await expect(households.getHouseholdShoppingListForUser(owner)).resolves.toMatchObject({
      items: [{ id: "item_0" }]
    });
    const shortListRequests = upstash.requestCount() - beforeShortList;

    await households.upsertShoppingItemsForUser(owner, {
      items: Array.from({ length: 12 }, (_, index) => shoppingItem(`item_${index + 1}`))
    });
    const beforeLongList = upstash.requestCount();
    const longList = await households.getHouseholdShoppingListForUser(owner);
    const longListRequests = upstash.requestCount() - beforeLongList;

    expect(longList.items).toHaveLength(13);
    expect(longListRequests).toBe(shortListRequests);
  });

  it("writes and deletes a batch of items in a fixed number of requests", async () => {
    const { households, upstash } = await importWithFakeUpstash();

    /*
     * Warm the owner's cached entitlement and start from a non-empty list
     * (reading an empty list skips the batched GET), so both measurements do
     * the same lookups.
     */
    await households.upsertShoppingItemsForUser(owner, { items: [shoppingItem("item_seed")] });

    const beforeSmallUpsert = upstash.requestCount();
    await households.upsertShoppingItemsForUser(owner, { items: [shoppingItem("item_a")] });
    const smallUpsertRequests = upstash.requestCount() - beforeSmallUpsert;

    const beforeLargeUpsert = upstash.requestCount();
    await households.upsertShoppingItemsForUser(owner, {
      items: Array.from({ length: 10 }, (_, index) => shoppingItem(`item_b${index}`))
    });
    const largeUpsertRequests = upstash.requestCount() - beforeLargeUpsert;

    expect(largeUpsertRequests).toBe(smallUpsertRequests);

    const beforeDelete = upstash.requestCount();
    const deleted = await households.deleteShoppingItemsForUser(owner, {
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `item_b${index}`,
        updatedAt: "2026-07-04T13:00:00.000Z"
      }))
    });
    const deleteRequests = upstash.requestCount() - beforeDelete;

    expect(deleted.deletedItemIds).toHaveLength(10);
    expect(deleteRequests).toBeLessThanOrEqual(smallUpsertRequests);
    const remaining = await households.getHouseholdShoppingListForUser(owner);
    expect(remaining.items.map((item) => item.id).sort()).toEqual(["item_a", "item_seed"]);
  });

  it("writes nothing when any item in the batch belongs to another household", async () => {
    const { households, upstash } = await importWithFakeUpstash();
    upstash.strings.set(
      "linkdish:household-shopping-item:v1:foreign_item",
      JSON.stringify({ ...shoppingItem("foreign_item"), householdId: "household_2" })
    );

    await expect(
      households.upsertShoppingItemsForUser(owner, {
        items: [shoppingItem("item_ok"), shoppingItem("foreign_item")]
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(upstash.strings.has("linkdish:household-shopping-item:v1:item_ok")).toBe(false);
  });
});
