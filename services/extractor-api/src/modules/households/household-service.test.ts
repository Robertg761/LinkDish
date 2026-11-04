import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { AccountUser } from "../../../../../packages/api-contracts/src/index.js";

const importHouseholdModules = async (env?: Record<string, string>) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    AUTH_MODE: "legacy_email_code",
    AUTH_SECRET: "test_auth_secret",
    HOUSEHOLD_INVITE_TTL_SECONDS: "604800",
    HOUSEHOLD_MEMBER_LIMIT: "6",
    HOUSEHOLD_REPLACEMENT_COOLDOWN_DAYS: "30",
    HOUSEHOLDS_ENABLED: "false",
    NODE_ENV: "test",
    REVENUECAT_FAMILY_ENTITLEMENT_ID: "Family",
    REVENUECAT_PLUS_ENTITLEMENT_ID: "Plus",
    REVENUECAT_SECRET_API_KEY: "test_revenuecat_secret",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: "https://upstash.invalid",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  const auth = await import("../auth/auth-service.js");
  const accountBilling = await import("../billing/account-billing-plan.js");
  const households = await import("./household-service.js");

  return {
    accountBilling,
    auth,
    households
  };
};

const stubRevenueCatFamily = (active: () => boolean) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            subscriber: {
              entitlements: active()
                ? {
                    Family: {
                      expires_date: "2099-01-01T00:00:00Z"
                    }
                  }
                : {}
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
      )
    )
  );
};

const stubRevenueCatFamilyForUserIds = (activeUserIds: Set<string>) => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const appUserId = decodeURIComponent(new URL(rawUrl).pathname.split("/").at(-1) ?? "");

      return Promise.resolve(
        new Response(
          JSON.stringify({
            subscriber: {
              entitlements: activeUserIds.has(appUserId)
                ? {
                    Family: {
                      expires_date: "2099-01-01T00:00:00Z"
                    }
                  }
                : {}
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
      );
    })
  );
};

const createUser = async (
  auth: Awaited<ReturnType<typeof importHouseholdModules>>["auth"],
  email: string
): Promise<AccountUser> => {
  await auth.requestLoginCode(email);
  return (await auth.verifyLoginCode(email, getLastLoginCode())).user;
};

let consoleInfoSpy: MockInstance<typeof console.info>;

const getLastConsoleCode = (prefix: string): string => {
  const message = [...consoleInfoSpy.mock.calls]
    .map(([entry]) => (typeof entry === "string" ? entry : ""))
    .reverse()
    .find((entry) => entry.startsWith(prefix));
  const code = message?.split(": ").at(-1)?.trim();

  if (!code) {
    throw new Error(`${prefix} code was not logged.`);
  }

  return code;
};

const getLastLoginCode = (): string => getLastConsoleCode("LinkDish login code for ");

const getLastInviteCode = (): string => getLastConsoleCode("LinkDish household invite for ");

const buildSharedRecipeInput = (title = "Soup") => ({
  fetchMode: "http" as const,
  provenance: ["visible-text" as const],
  recipe: {
    title,
    sourceUrl: `https://example.com/${title.toLowerCase().replace(/\s+/gu, "-")}`,
    sourceType: "article" as const,
    ingredients: [{ text: "1 onion" }],
    steps: [{ index: 1, text: "Cook." }],
    servings: "4 servings",
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    nutrition: null,
    confidence: {
      score: 0.9,
      summary: "Confident extraction.",
      missingFields: [],
      notes: [],
      fieldProvenance: {
        title: "visible-text" as const,
        ingredients: "visible-text" as const,
        steps: "visible-text" as const,
        servings: "visible-text" as const,
        prepTimeMinutes: "visible-text" as const,
        cookTimeMinutes: "visible-text" as const,
        nutrition: null
      }
    }
  },
  sourceSavedRecipeId: "local-soup",
  strategy: "article-pattern" as const,
  warnings: []
});

const buildShoppingItem = (
  id: string,
  addedBy: string,
  updatedAt: string,
  overrides: Partial<{
    checked: boolean;
    checkedBy: string | null;
    recipeId: string | null;
    recipeTitle: string | null;
    section: string | null;
    text: string;
    unit: string | null;
  }> = {}
) => ({
  addedBy,
  checked: overrides.checked ?? false,
  checkedBy: overrides.checkedBy ?? null,
  id,
  recipeId: overrides.recipeId ?? null,
  recipeTitle: overrides.recipeTitle ?? null,
  section: overrides.section ?? null,
  text: overrides.text ?? "olive oil",
  unit: overrides.unit ?? null,
  updatedAt
});

beforeEach(() => {
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("household-service", () => {
  it("requires Family entitlement before creating a household", async () => {
    stubRevenueCatFamily(() => false);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");

    await expect(households.createHouseholdForOwner(owner)).rejects.toMatchObject({
      message: "LinkDish Family is required to create a household.",
      statusCode: 403
    });
  });

  it("allows configured test premium accounts to create a household", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { auth, households } = await importHouseholdModules({
      LINKDISH_TEST_PREMIUM_PLAN_ID: "family",
      LINKDISH_TEST_PREMIUM_USER_IDS: "user_testhousehold"
    });
    const store = await import("../storage/upstash-store.js");
    const now = new Date().toISOString();
    const ownerRecord = {
      createdAt: now,
      email: "test-household@example.com",
      emailHash: auth.hashEmail("test-household@example.com"),
      id: "user_testhousehold",
      updatedAt: now
    };

    await store.setStoreString(auth.authKeys.user(ownerRecord.id), JSON.stringify(ownerRecord));

    await expect(
      households.createHouseholdForOwner({
        email: ownerRecord.email,
        id: ownerRecord.id
      })
    ).resolves.toMatchObject({
      ownerFamilyEntitlementActive: true,
      ownerUserId: ownerRecord.id,
      role: "owner"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a full debug household simulation with owner session access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { households } = await importHouseholdModules({
      NODE_ENV: "development"
    });

    const simulation = await households.createDebugFullHouseholdSimulation();

    expect(simulation.sessionToken).toHaveLength(43);
    expect(simulation.user.email).toBe("debug-owner@linkdish.test");
    expect(simulation.household).toMatchObject({
      activeMemberCount: 6,
      memberLimit: 6,
      ownerFamilyEntitlementActive: true,
      role: "owner"
    });
    expect(simulation.household.members.map((member) => member.email)).toEqual([
      "debug-owner@linkdish.test",
      "debug-alex@linkdish.test",
      "debug-sam@linkdish.test",
      "debug-jamie@linkdish.test",
      "debug-priya@linkdish.test",
      "debug-morgan@linkdish.test"
    ]);
    expect(simulation.recipes).toHaveLength(4);

    const sharedRecipes = await households.getSharedRecipesForUser(simulation.user);
    expect(
      sharedRecipes.recipes.some(
        (recipe) =>
          recipe.ownerEmail === "debug-jamie@linkdish.test" &&
          recipe.recipe.title === "Citrus Breakfast Muffins"
      )
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks the debug household simulation in production", async () => {
    const { households } = await importHouseholdModules({
      NODE_ENV: "production"
    });

    await expect(households.createDebugFullHouseholdSimulation()).rejects.toMatchObject({
      message: "The household simulator is not available in production.",
      statusCode: 404
    });
  });

  it("enforces invite email matching and member replacement cooldowns", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules({
      HOUSEHOLD_MEMBER_LIMIT: "2"
    });
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");
    const other = await createUser(auth, "other@example.com");

    const household = await households.createHouseholdForOwner(owner);
    const duplicateHousehold = await households.createHouseholdForOwner(owner);
    expect(duplicateHousehold.id).toBe(household.id);

    await households.createHouseholdInvite(owner, member.email);
    const inviteCode = getLastInviteCode();

    await expect(households.acceptHouseholdInvite(other, inviteCode)).rejects.toMatchObject({
      message: "This invite was sent to a different email address.",
      statusCode: 403
    });

    const accepted = await households.acceptHouseholdInvite(member, inviteCode);
    expect(accepted.activeMemberCount).toBe(2);

    const afterRemove = await households.removeHouseholdMember(owner, member.id);
    expect(afterRemove.activeMemberCount).toBe(1);
    expect(afterRemove.cooldownSlotCount).toBe(1);

    await expect(households.createHouseholdInvite(owner, other.email)).rejects.toMatchObject({
      message: "This household has no available member slots right now.",
      statusCode: 409
    });
  });

  it("returns a shareable invite code and HTTPS invite URL when creating an invite", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules({
      LINKDISH_PUBLIC_SITE_URL: "https://join.linkdish.test/app/"
    });
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);

    const response = await households.createHouseholdInvite(owner, member.email);

    expect(response.invite).toMatchObject({
      email: member.email,
      inviteUrl: `https://join.linkdish.test/app/invite/?code=${encodeURIComponent(
        response.invite.inviteCode
      )}`
    });
    expect(response.invite.inviteCode).toHaveLength(24);
    expect(response.invite.id).not.toBe(response.invite.inviteCode);
    expect(response.household.invites[0]).not.toHaveProperty("inviteCode");
    expect(response.household.invites[0]).not.toHaveProperty("inviteUrl");

    const accepted = await households.acceptHouseholdInvite(member, response.invite.inviteCode);
    expect(accepted.activeMemberCount).toBe(2);
  });

  it("revokes household quota when the owner loses Family entitlement", async () => {
    let familyActive = true;
    stubRevenueCatFamily(() => familyActive);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    const created = await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    await expect(households.getActiveHouseholdQuotaForUser(member.id)).resolves.toMatchObject({
      householdId: created.id,
      ownerUserId: owner.id,
      role: "member"
    });

    familyActive = false;
    /* The owner's Family entitlement is cached until the next RevenueCat event for them. */
    await expect(households.getActiveHouseholdQuotaForUser(member.id)).resolves.not.toBeNull();

    const { invalidateRevenueCatEntitlementCache } =
      await import("../billing/revenuecat-entitlements.js");
    await invalidateRevenueCatEntitlementCache(owner.id);
    await expect(households.getActiveHouseholdQuotaForUser(member.id)).resolves.toBeNull();
  });

  it("serves household reads from the cached owner entitlement", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            subscriber: {
              entitlements: { Family: { expires_date: "2099-01-01T00:00:00Z" } }
            }
          }),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");

    await households.createHouseholdForOwner(owner);
    const callsAfterCreate = fetchMock.mock.calls.length;

    await households.getActiveHouseholdQuotaForUser(owner.id);
    await households.getHouseholdSummaryForUser(owner.id);
    await households.getSharedRecipesForUser(owner);

    expect(fetchMock.mock.calls.length).toBe(callsAfterCreate);
  });

  it("reports active household members as effective Family accounts", async () => {
    const familyOwnerUserIds = new Set<string>();
    stubRevenueCatFamilyForUserIds(familyOwnerUserIds);
    const { accountBilling, auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    familyOwnerUserIds.add(owner.id);
    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    await expect(accountBilling.getEffectiveAccountBillingPlanId(member.id)).resolves.toBe(
      "family"
    );
  });

  it("shares household recipes while enforcing recipe ownership", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    const created = await households.upsertSharedRecipeForUser(
      owner,
      buildSharedRecipeInput("Soup")
    );
    const refreshed = await households.upsertSharedRecipeForUser(
      owner,
      buildSharedRecipeInput("Better Soup")
    );

    expect(refreshed.id).toBe(created.id);

    await expect(households.getSharedRecipesForUser(member)).resolves.toMatchObject({
      recipes: [
        {
          id: created.id,
          ownerEmail: owner.email,
          ownerUserId: owner.id,
          recipe: {
            title: "Better Soup"
          }
        }
      ]
    });

    await expect(
      households.updateSharedRecipeForUser(member, created.id, {
        notes: "Member edit"
      })
    ).rejects.toMatchObject({
      message: "Only the recipe owner can edit this shared recipe.",
      statusCode: 403
    });

    await expect(households.deleteSharedRecipeForUser(member, created.id)).rejects.toMatchObject({
      message: "Only the recipe owner can remove this shared recipe.",
      statusCode: 403
    });

    await expect(
      households.updateSharedRecipeForUser(owner, created.id, {
        recipe: {
          ...created.recipe,
          title: "Owner Soup"
        }
      })
    ).resolves.toMatchObject({
      recipe: {
        title: "Owner Soup"
      }
    });

    const withNotes = await households.updateSharedRecipeForUser(owner, created.id, {
      notes: "Use the wide pot."
    });
    expect(withNotes.notes).toBe("Use the wide pot.");

    const withoutNotes = await households.updateSharedRecipeForUser(owner, created.id, {
      notes: null
    });
    expect(withoutNotes.notes).toBeUndefined();

    await expect(households.deleteSharedRecipeForUser(owner, created.id)).resolves.toEqual({
      status: "deleted"
    });
    await expect(households.getSharedRecipesForUser(member)).resolves.toEqual({
      recipes: []
    });
  });

  it("deduplicates concurrent shared recipe upserts for the same source recipe", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    const [created, refreshed] = await Promise.all([
      households.upsertSharedRecipeForUser(owner, buildSharedRecipeInput("Race Soup")),
      households.upsertSharedRecipeForUser(owner, buildSharedRecipeInput("Race Soup Updated"))
    ]);

    expect(refreshed.id).toBe(created.id);

    const sharedRecipes = await households.getSharedRecipesForUser(member);
    expect(sharedRecipes.recipes).toHaveLength(1);
    expect(sharedRecipes.recipes[0]).toMatchObject({
      id: created.id,
      ownerUserId: owner.id,
      sourceSavedRecipeId: "local-soup"
    });
  });

  it("removes a member's shared recipes when they leave the household", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    await households.upsertSharedRecipeForUser(member, buildSharedRecipeInput("Member Soup"));
    await expect(households.getSharedRecipesForUser(owner)).resolves.toMatchObject({
      recipes: [
        {
          ownerUserId: member.id
        }
      ]
    });

    await households.leaveHousehold(member);

    await expect(households.getSharedRecipesForUser(owner)).resolves.toEqual({
      recipes: []
    });
  });

  it("enforces household membership for shopping list access", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");
    const outsider = await createUser(auth, "outsider@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    await expect(
      households.upsertShoppingItemsForUser(owner, {
        items: [buildShoppingItem("shopping_item_1", "spoofed_user", "2026-07-04T12:00:00.000Z")]
      })
    ).resolves.toMatchObject({
      items: [
        {
          addedBy: owner.id,
          id: "shopping_item_1"
        }
      ]
    });

    await expect(households.getHouseholdShoppingListForUser(member)).resolves.toMatchObject({
      items: [
        {
          id: "shopping_item_1"
        }
      ]
    });

    await expect(households.getHouseholdShoppingListForUser(outsider)).rejects.toMatchObject({
      message: "An active LinkDish Family household is required.",
      statusCode: 403
    });
  });

  it("applies shopping item last-write-wins per item without list replacement", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    await households.upsertShoppingItemsForUser(owner, {
      items: [
        buildShoppingItem("shopping_item_a", owner.id, "2026-07-04T12:00:00.000Z", {
          text: "olive oil"
        }),
        buildShoppingItem("shopping_item_b", owner.id, "2026-07-04T12:00:00.000Z", {
          text: "lemons"
        })
      ]
    });

    const conflictResult = await households.upsertShoppingItemsForUser(member, {
      items: [
        buildShoppingItem("shopping_item_a", member.id, "2026-07-04T11:59:00.000Z", {
          checked: true,
          checkedBy: member.id,
          text: "stale olive oil"
        }),
        buildShoppingItem("shopping_item_b", member.id, "2026-07-04T12:01:00.000Z", {
          checked: true,
          checkedBy: member.id,
          text: "lemons"
        })
      ]
    });

    expect(conflictResult.ignored).toEqual([
      {
        existingUpdatedAt: "2026-07-04T12:00:00.000Z",
        id: "shopping_item_a",
        reason: "older_update"
      }
    ]);
    expect(conflictResult.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checked: false,
          id: "shopping_item_a",
          text: "olive oil"
        }),
        expect.objectContaining({
          checked: true,
          checkedBy: member.id,
          id: "shopping_item_b",
          text: "lemons"
        })
      ])
    );

    await households.upsertShoppingItemsForUser(owner, {
      items: [
        buildShoppingItem("shopping_item_a", owner.id, "2026-07-04T12:02:00.000Z", {
          text: "extra virgin olive oil"
        })
      ]
    });

    const shoppingList = await households.getHouseholdShoppingListForUser(member);
    expect(shoppingList.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "shopping_item_a",
          text: "extra virgin olive oil"
        }),
        expect.objectContaining({
          checked: true,
          id: "shopping_item_b"
        })
      ])
    );
  });

  it("deletes shopping items in timestamped batches with item-level conflicts", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    await households.upsertShoppingItemsForUser(owner, {
      items: [
        buildShoppingItem("shopping_item_a", owner.id, "2026-07-04T12:00:00.000Z"),
        buildShoppingItem("shopping_item_b", owner.id, "2026-07-04T12:00:00.000Z", {
          text: "lemons"
        })
      ]
    });

    const deleted = await households.deleteShoppingItemsForUser(member, {
      items: [
        {
          id: "shopping_item_a",
          updatedAt: "2026-07-04T11:59:00.000Z"
        },
        {
          id: "shopping_item_b",
          updatedAt: "2026-07-04T12:01:00.000Z"
        }
      ]
    });

    expect(deleted).toEqual({
      deletedItemIds: ["shopping_item_b"],
      ignored: [
        {
          existingUpdatedAt: "2026-07-04T12:00:00.000Z",
          id: "shopping_item_a",
          reason: "older_update"
        }
      ],
      status: "deleted"
    });

    await expect(households.getHouseholdShoppingListForUser(owner)).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          id: "shopping_item_a"
        })
      ]
    });
  });

  it("enforces the household shopping list item limit", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");

    await households.createHouseholdForOwner(owner);
    await households.upsertShoppingItemsForUser(owner, {
      items: Array.from({ length: 300 }, (_, index) =>
        buildShoppingItem(
          `shopping_item_${index}`,
          owner.id,
          `2026-07-04T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
          {
            text: `item ${index}`
          }
        )
      )
    });

    await expect(
      households.upsertShoppingItemsForUser(owner, {
        items: [buildShoppingItem("shopping_item_overflow", owner.id, "2026-07-04T13:00:00.000Z")]
      })
    ).rejects.toMatchObject({
      message: "Household shopping lists can hold up to 300 items.",
      statusCode: 409
    });
  });

  it("requires active Family entitlement to remove members", async () => {
    let familyActive = true;
    stubRevenueCatFamily(() => familyActive);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    familyActive = false;
    await expect(households.removeHouseholdMember(owner, member.id)).rejects.toMatchObject({
      message: "LinkDish Family is required to manage household members.",
      statusCode: 403
    });
  });

  it("rolls back pending invites when email delivery fails", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const { extractorApiEnv } = await import("../../config/env.js");
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);

    extractorApiEnv.AUTH_EMAIL_FROM = "LinkDish <login@example.com>";
    extractorApiEnv.RESEND_API_KEY = "resend_test";

    let resendSucceeds = false;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://api.resend.com/emails") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "temporarily unavailable" }), {
            headers: {
              "content-type": "application/json"
            },
            status: resendSucceeds ? 200 : 503
          })
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            subscriber: {
              entitlements: {
                Family: {
                  expires_date: "2099-01-01T00:00:00Z"
                }
              }
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(households.createHouseholdInvite(owner, member.email)).rejects.toMatchObject({
      message: "LinkDish could not send the household invite right now.",
      statusCode: 503
    });

    resendSucceeds = true;
    const sentInvite = await households.createHouseholdInvite(owner, member.email);
    expect(sentInvite).toMatchObject({
      invite: {
        email: member.email
      }
    });

    const resendCalls = fetchMock.mock.calls.filter(([input]) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url === "https://api.resend.com/emails";
    });
    expect(resendCalls).toHaveLength(2);
    const latestEmailRequestBody = resendCalls.at(-1)?.[1]?.body;
    const sentEmailBody = JSON.parse(
      typeof latestEmailRequestBody === "string" ? latestEmailRequestBody : "{}"
    ) as {
      html?: string;
      text?: string;
    };
    expect(sentEmailBody.html).toContain(sentInvite.invite.inviteCode);
    expect(sentEmailBody.html).not.toContain(sentInvite.invite.inviteUrl);
    expect(sentEmailBody.html).not.toContain("linkdish://");
    expect(sentEmailBody.text).toContain(sentInvite.invite.inviteCode);
    expect(sentEmailBody.text).not.toContain(sentInvite.invite.inviteUrl);
    expect(sentEmailBody.text).not.toContain("linkdish://");
  });

  it("lets owners cancel pending invites and send a fresh one", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    const createdInvite = await households.createHouseholdInvite(owner, member.email);
    const canceledInviteCode = getLastInviteCode();

    expect(createdInvite.household.invites).toHaveLength(1);

    await expect(
      households.cancelHouseholdInvite(owner, createdInvite.invite.id)
    ).resolves.toMatchObject({
      household: {
        invites: []
      }
    });

    await expect(
      households.acceptHouseholdInvite(member, canceledInviteCode)
    ).rejects.toMatchObject({
      message: "That household invite is no longer valid.",
      statusCode: 404
    });

    await expect(households.createHouseholdInvite(owner, member.email)).resolves.toMatchObject({
      invite: {
        email: member.email
      }
    });
  });

  it("doesn't let an invite canceled while it was being accepted add the member", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const entitlements = await import("../billing/revenuecat-entitlements.js");
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    const createdInvite = await households.createHouseholdInvite(owner, member.email);
    const inviteCode = getLastInviteCode();

    // The owner's plan is checked again as the invite is accepted, and RevenueCat is slow.
    await entitlements.invalidateRevenueCatEntitlementCache(owner.id);
    let answerRevenueCat: () => void = () => undefined;
    const slowAnswer = new Promise<void>((resolve) => {
      answerRevenueCat = resolve;
    });
    const fetchFamily = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementationOnce(async (...args) => {
      await slowAnswer;
      return fetchFamily!(...args);
    });

    const callsBefore = vi.mocked(fetch).mock.calls.length;
    const accepting = households.acceptHouseholdInvite(member, inviteCode);
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(callsBefore));

    // Meanwhile the owner cancels the invite (it is gone once the cancel holds the household).
    const canceling = households.cancelHouseholdInvite(owner, createdInvite.invite.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    answerRevenueCat();
    await canceling;

    await expect(accepting).rejects.toMatchObject({
      message: "That household invite is no longer valid.",
      statusCode: 404
    });
    expect(await households.getHouseholdSummaryForUser(member.id)).toEqual({ household: null });
  });

  it("deletes standalone account records", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const user = await createUser(auth, "standalone@example.com");

    await households.deleteAccountAndHouseholdAccess(user, " STANDALONE@example.com ");

    await expect(auth.getUserByEmail("standalone@example.com")).resolves.toBeNull();
  });

  it("deletes the account's analytics with the account", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules({ ANALYTICS_ENABLED: "true" });
    const analytics = await import("../analytics/analytics-store.js");
    const { hashAnalyticsUserId } = await import("../analytics/analytics-privacy.js");
    const user = await createUser(auth, "counted@example.com");

    await analytics.writeAnalyticsEvents([
      {
        accountUserHash: hashAnalyticsUserId(user.id),
        eventName: "web_app_loaded",
        platform: "web_app",
        properties: {}
      },
      {
        accountUserHash: hashAnalyticsUserId("someone-else"),
        eventName: "web_app_loaded",
        platform: "web_app",
        properties: {}
      }
    ]);

    await households.deleteAccountAndHouseholdAccess(user, user.email);

    await expect(analytics.getAnalyticsDashboardSummary()).resolves.toMatchObject({
      totals: { events: 1 }
    });
  });

  it("deletes the account's cloud cookbook with the account", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules({ LIBRARY_SYNC_ENABLED: "true" });
    const library = await import("../library/library-service.js");
    const user = await createUser(auth, "cook@example.com");
    const recipe = buildSharedRecipeInput();

    const pushed = await library.pushLibraryChanges(user.id, [
      {
        id: "recipe_1",
        kind: "recipe",
        recipe: {
          createdAt: "2026-10-26T10:00:00.000Z",
          fetchMode: recipe.fetchMode,
          provenance: recipe.provenance,
          recipe: recipe.recipe,
          strategy: recipe.strategy,
          warnings: []
        },
        updatedAt: "2026-10-26T10:00:00.000Z"
      }
    ]);
    expect(pushed.accepted).toEqual([{ id: "recipe_1", kind: "recipe" }]);

    await households.deleteAccountAndHouseholdAccess(user, user.email);

    await expect(library.pullLibraryChanges(user.id, "0")).resolves.toEqual({
      changes: [],
      cursor: "0",
      hasMore: false
    });
  });

  it("transfers the household to the longest-standing member when the owner deletes their account", async () => {
    stubRevenueCatFamily(() => true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const firstMember = await createUser(auth, "first@example.com");
    const secondMember = await createUser(auth, "second@example.com");
    const pending = await createUser(auth, "pending@example.com");
    const lateJoiner = await createUser(auth, "late@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, firstMember.email);
    const firstInviteCode = getLastInviteCode();
    await households.createHouseholdInvite(owner, secondMember.email);
    const secondInviteCode = getLastInviteCode();
    // Second member joins first in time order of invites, but the first member joins earlier.
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));
    await households.acceptHouseholdInvite(firstMember, firstInviteCode);
    vi.setSystemTime(new Date("2026-07-03T12:00:00.000Z"));
    await households.acceptHouseholdInvite(secondMember, secondInviteCode);
    await households.createHouseholdInvite(owner, pending.email);
    const ownerIssuedInviteCode = getLastInviteCode();

    await households.upsertSharedRecipeForUser(owner, buildSharedRecipeInput("Owner Soup"));
    await households.upsertSharedRecipeForUser(firstMember, buildSharedRecipeInput("First Soup"));
    await households.upsertSharedRecipeForUser(secondMember, buildSharedRecipeInput("Second Soup"));
    await households.upsertShoppingItemsForUser(owner, {
      items: [buildShoppingItem("owner_item", owner.id, "2026-07-03T12:00:00.000Z")]
    });
    await households.upsertShoppingItemsForUser(firstMember, {
      items: [buildShoppingItem("first_item", firstMember.id, "2026-07-03T12:00:00.000Z")]
    });
    await households.upsertShoppingItemsForUser(secondMember, {
      items: [buildShoppingItem("second_item", secondMember.id, "2026-07-03T12:00:00.000Z")]
    });

    await households.deleteAccountAndHouseholdAccess(owner, owner.email);

    await expect(auth.getUserByEmail(owner.email)).resolves.toBeNull();
    await expect(households.getHouseholdSummaryForUser(owner.id)).resolves.toEqual({
      household: null
    });

    const newOwnerSummary = await households.getHouseholdSummaryForUser(firstMember.id);
    expect(newOwnerSummary.household).toMatchObject({
      activeMemberCount: 2,
      cooldownSlotCount: 0,
      ownerUserId: firstMember.id,
      role: "owner"
    });
    expect(newOwnerSummary.household?.members.map((member) => member.userId).sort()).toEqual(
      [firstMember.id, secondMember.id].sort()
    );
    expect(newOwnerSummary.household?.invites).toEqual([]);
    await expect(households.getHouseholdSummaryForUser(secondMember.id)).resolves.toMatchObject({
      household: { ownerUserId: firstMember.id, role: "member" }
    });

    const sharedRecipes = await households.getSharedRecipesForUser(secondMember);
    expect(sharedRecipes.recipes.map((recipe) => recipe.ownerUserId).sort()).toEqual(
      [firstMember.id, secondMember.id].sort()
    );

    const shoppingList = await households.getHouseholdShoppingListForUser(secondMember);
    expect(shoppingList.items.map((item) => item.id).sort()).toEqual(["first_item", "second_item"]);

    await expect(
      households.acceptHouseholdInvite(pending, ownerIssuedInviteCode)
    ).rejects.toMatchObject({
      message: "That household invite is no longer valid.",
      statusCode: 404
    });

    // Invites issued by a remaining member (today only the owner can invite, so the new owner)
    // keep working after the transfer.
    await households.createHouseholdInvite(firstMember, lateJoiner.email);
    await households.acceptHouseholdInvite(lateJoiner, getLastInviteCode());
    await expect(households.getHouseholdSummaryForUser(lateJoiner.id)).resolves.toMatchObject({
      household: { ownerUserId: firstMember.id, role: "member" }
    });
    vi.useRealTimers();
  });

  it("copies the shared book into members' own cookbooks when the new owner has no Family", async () => {
    const familyUsers = new Set<string>();
    stubRevenueCatFamilyForUserIds(familyUsers);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
    const { auth, households } = await importHouseholdModules({ LIBRARY_SYNC_ENABLED: "true" });
    const library = await import("../library/library-service.js");
    const enforceBilling = await import("../billing/enforce-billing.js");
    const owner = await createUser(auth, "owner@example.com");
    const firstMember = await createUser(auth, "first@example.com");
    const secondMember = await createUser(auth, "second@example.com");
    familyUsers.add(owner.id);

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, firstMember.email);
    const firstCode = getLastInviteCode();
    await households.createHouseholdInvite(owner, secondMember.email);
    const secondCode = getLastInviteCode();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));
    await households.acceptHouseholdInvite(firstMember, firstCode);
    vi.setSystemTime(new Date("2026-07-03T12:00:00.000Z"));
    await households.acceptHouseholdInvite(secondMember, secondCode);

    await households.upsertSharedRecipeForUser(owner, buildSharedRecipeInput("Owner Soup"));
    await households.upsertSharedRecipeForUser(firstMember, buildSharedRecipeInput("First Soup"));
    await households.upsertSharedRecipeForUser(secondMember, buildSharedRecipeInput("Second Soup"));
    // The second member already has First Soup in their own cookbook: it must not be copied again.
    await library.pushLibraryChanges(secondMember.id, [
      {
        id: "saved-first-soup",
        kind: "recipe",
        recipe: {
          ...buildSharedRecipeInput("First Soup"),
          createdAt: "2026-07-03T12:00:00.000Z",
          sourceSavedRecipeId: undefined
        },
        updatedAt: "2026-07-03T12:00:00.000Z"
      }
    ]);
    const quotaEntriesBefore = enforceBilling.getInMemoryQuotaEntryCount();

    const outcome = await households.copySharedRecipesToMembersIfSuccessorLacksFamily(owner.id);
    expect(outcome?.copiedByUser).toEqual({ [firstMember.id]: 2, [secondMember.id]: 1 });
    // Running it again copies nothing.
    const rerun = await households.copySharedRecipesToMembersIfSuccessorLacksFamily(owner.id);
    expect(rerun?.copiedByUser).toEqual({ [firstMember.id]: 0, [secondMember.id]: 0 });

    await households.deleteAccountAndHouseholdAccess(owner, owner.email);

    const titlesFor = async (userId: string) => {
      const pulled = await library.pullLibraryChanges(userId, "0");
      return pulled.changes
        .filter((change) => change.kind === "recipe" && !change.deleted)
        .map((change) => ({ origin: change.recipe?.origin, title: change.recipe?.recipe.title }))
        .sort((left, right) => String(left.title).localeCompare(String(right.title)));
    };

    expect(await titlesFor(firstMember.id)).toEqual([
      { origin: "household-deletion-copy", title: "First Soup" },
      { origin: "household-deletion-copy", title: "Second Soup" }
    ]);
    expect(await titlesFor(secondMember.id)).toEqual([
      { origin: undefined, title: "First Soup" },
      { origin: "household-deletion-copy", title: "Second Soup" }
    ]);
    // The departing owner's own recipe is not copied, and no import was counted.
    expect(enforceBilling.getInMemoryQuotaEntryCount()).toBe(quotaEntriesBefore);
    await expect(households.getHouseholdSummaryForUser(firstMember.id)).resolves.toMatchObject({
      household: { ownerUserId: firstMember.id }
    });
    vi.useRealTimers();
  });

  it("skips the private copy when the new owner already has Family", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules({ LIBRARY_SYNC_ENABLED: "true" });
    const library = await import("../library/library-service.js");
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());
    await households.upsertSharedRecipeForUser(member, buildSharedRecipeInput("Member Soup"));

    await households.deleteAccountAndHouseholdAccess(owner, owner.email);

    const pulled = await library.pullLibraryChanges(member.id, "0");
    expect(pulled.changes).toEqual([]);
  });

  it("still deletes the account and transfers the household when the copy step fails", async () => {
    // The successor has no Family, so the copy path is entered; its library write then fails.
    // (A rejected entitlement lookup alone is caught inside the copy step and reads as "no
    // Family", so the failure is forced on the library write instead.)
    const familyUsers = new Set<string>();
    stubRevenueCatFamilyForUserIds(familyUsers);
    const writeCopies = vi.fn(() => Promise.reject(new Error("library store unavailable")));
    vi.doMock("../library/library-service.js", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      writeHouseholdDeletionCopiesForUser: writeCopies
    }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { auth, households } = await importHouseholdModules({ LIBRARY_SYNC_ENABLED: "true" });
      const owner = await createUser(auth, "owner@example.com");
      const member = await createUser(auth, "member@example.com");
      familyUsers.add(owner.id);

      await households.createHouseholdForOwner(owner);
      await households.createHouseholdInvite(owner, member.email);
      await households.acceptHouseholdInvite(member, getLastInviteCode());
      await households.upsertSharedRecipeForUser(member, buildSharedRecipeInput("Member Soup"));

      await expect(
        households.deleteAccountAndHouseholdAccess(owner, owner.email)
      ).resolves.not.toThrow();

      expect(writeCopies).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to copy shared recipes for a departing household owner.",
        expect.any(Error)
      );
      await expect(auth.getUserByEmail(owner.email)).resolves.toBeNull();
      await expect(households.getHouseholdSummaryForUser(member.id)).resolves.toMatchObject({
        household: { ownerUserId: member.id, role: "owner" }
      });
    } finally {
      vi.doUnmock("../library/library-service.js");
    }
  });

  it("still deletes the account and dissolves the household when the transfer fails", async () => {
    stubRevenueCatFamily(() => true);
    let failHouseholdWrite = false;
    vi.doMock("../storage/upstash-store.js", async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      const realSetStoreString = actual.setStoreString as (
        key: string,
        ...rest: unknown[]
      ) => unknown;
      return {
        ...actual,
        setStoreString: (key: string, ...rest: unknown[]) => {
          if (failHouseholdWrite && key.startsWith("linkdish:household:")) {
            failHouseholdWrite = false;
            throw new Error("household store write failed");
          }
          return realSetStoreString(key, ...rest);
        }
      };
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { auth, households } = await importHouseholdModules();
      const owner = await createUser(auth, "owner@example.com");
      const member = await createUser(auth, "member@example.com");

      await households.createHouseholdForOwner(owner);
      await households.createHouseholdInvite(owner, member.email);
      await households.acceptHouseholdInvite(member, getLastInviteCode());

      failHouseholdWrite = true;
      await expect(
        households.deleteAccountAndHouseholdAccess(owner, owner.email)
      ).resolves.not.toThrow();

      expect(failHouseholdWrite).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to transfer household ownership, closing the household.",
        expect.any(Error)
      );
      await expect(auth.getUserByEmail(owner.email)).resolves.toBeNull();
      await expect(households.getHouseholdSummaryForUser(member.id)).resolves.toEqual({
        household: null
      });
      await expect(households.getHouseholdSummaryForUser(owner.id)).resolves.toEqual({
        household: null
      });
    } finally {
      vi.doUnmock("../storage/upstash-store.js");
    }
  });

  it("dissolves a household and pending invites when the owner deletes their account as the last member", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const pending = await createUser(auth, "pending@example.com");

    await households.createHouseholdForOwner(owner);
    await households.upsertSharedRecipeForUser(owner, buildSharedRecipeInput("Owner Soup"));
    await households.createHouseholdInvite(owner, pending.email);
    const pendingInviteCode = getLastInviteCode();

    await households.deleteAccountAndHouseholdAccess(owner, owner.email);

    await expect(auth.getUserByEmail(owner.email)).resolves.toBeNull();
    await expect(households.getHouseholdSummaryForUser(owner.id)).resolves.toEqual({
      household: null
    });
    await expect(
      households.acceptHouseholdInvite(pending, pendingInviteCode)
    ).rejects.toMatchObject({
      message: "That household invite is no longer valid.",
      statusCode: 404
    });
    await expect(households.getHouseholdSummaryForUser(pending.id)).resolves.toEqual({
      household: null
    });
  });

  it("removes a deleted member and starts the replacement cooldown", async () => {
    stubRevenueCatFamily(() => true);
    const { auth, households } = await importHouseholdModules();
    const owner = await createUser(auth, "owner@example.com");
    const member = await createUser(auth, "member@example.com");

    await households.createHouseholdForOwner(owner);
    await households.createHouseholdInvite(owner, member.email);
    await households.acceptHouseholdInvite(member, getLastInviteCode());

    await households.deleteAccountAndHouseholdAccess(member, member.email);

    const ownerSummary = await households.getHouseholdSummaryForUser(owner.id);
    expect(ownerSummary.household).toMatchObject({
      activeMemberCount: 1,
      cooldownSlotCount: 1
    });
    await expect(auth.getUserByEmail(member.email)).resolves.toBeNull();
  });
});
