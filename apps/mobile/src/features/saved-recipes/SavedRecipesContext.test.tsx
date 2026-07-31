import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain";
import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SavedRecipesProvider, useSavedRecipes } from "./SavedRecipesContext";
import { createSavedRecipeRecord, starterRecipeSeedRecordToSavedRecipeRecord } from "./store";

import type { BillingTier } from "../billing/plans";
import type { SuccessfulExtractionState } from "../recipe-results/types";
import type { ExtractorApiClient } from "@linkdish/api-client";
import type { HouseholdDetails, SharedRecipe } from "@linkdish/api-contracts";

const accountState = vi.hoisted(() => ({
  getAuthHeaders: vi.fn(),
  isSignedIn: false,
  sessionToken: null as string | null,
  user: null as { email: string; id: string } | null
}));

const billingState = vi.hoisted(() => ({
  tier: "free" as BillingTier
}));

const apiMocks = vi.hoisted(() => ({
  createExtractorApiClient: vi.fn(),
  createSharedRecipe: vi.fn(),
  deleteSharedRecipe: vi.fn(),
  getHousehold: vi.fn(),
  getSharedRecipes: vi.fn(),
  updateSharedRecipe: vi.fn()
}));

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn()
}));

const analyticsMocks = vi.hoisted(() => ({
  trackMobileEvent: vi.fn()
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("../../analytics/client", () => ({
  trackMobileEvent: analyticsMocks.trackMobileEvent
}));

vi.mock("@linkdish/api-client", () => ({
  ExtractorApiError: class ExtractorApiError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown
    ) {
      super(message);
    }
  },
  createExtractorApiClient: apiMocks.createExtractorApiClient
}));

vi.mock("../account/AccountContext", () => ({
  useAccount: () => accountState
}));

vi.mock("../billing/BillingContext", () => ({
  useBilling: () => billingState
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const buildSuccessState = (index: number): SuccessfulExtractionState => ({
  state: "success",
  fetchMode: "http",
  provenance: ["visible-text"],
  recipe: {
    title: `Soup ${index}`,
    sourceUrl: `https://example.com/soup-${index}`,
    sourceType: "article",
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
        title: "visible-text",
        ingredients: "visible-text",
        steps: "visible-text",
        servings: "visible-text",
        prepTimeMinutes: "visible-text",
        cookTimeMinutes: "visible-text",
        nutrition: null
      }
    }
  },
  strategy: "article-pattern",
  warnings: []
});

const buildSavedRecipes = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    createSavedRecipeRecord(
      buildSuccessState(index),
      `2026-04-19T12:${String(index).padStart(2, "0")}:00.000Z`
    )
  );

const buildHousehold = (): HouseholdDetails => ({
  activeMemberCount: 2,
  cooldownSlotCount: 0,
  id: "household_1",
  invites: [],
  memberLimit: 5,
  members: [
    {
      email: "owner@example.com",
      joinedAt: "2026-04-19T12:00:00.000Z",
      role: "owner",
      userId: "owner_1"
    },
    {
      email: "member@example.com",
      joinedAt: "2026-04-19T12:05:00.000Z",
      role: "member",
      userId: "member_1"
    }
  ],
  ownerFamilyEntitlementActive: true,
  ownerUserId: "owner_1",
  role: "member"
});

const buildSharedRecipe = (index: number, id = `shared_recipe_${index}`): SharedRecipe => ({
  createdAt: "2026-04-19T12:05:00.000Z",
  fetchMode: "http",
  householdId: "household_1",
  id,
  ownerEmail: "owner@example.com",
  ownerUserId: "owner_1",
  provenance: ["visible-text"],
  recipe: buildSuccessState(index).recipe,
  sourceSavedRecipeId: `source-${index}`,
  strategy: "article-pattern",
  updatedAt: "2026-04-19T12:05:00.000Z",
  warnings: []
});

const createMockClient = (): ExtractorApiClient =>
  ({
    acceptHouseholdInvite: vi.fn(),
    cancelHouseholdInvite: vi.fn(),
    createHousehold: vi.fn(),
    createHouseholdInvite: vi.fn(),
    createWebBillingCheckout: vi.fn(),
    createWebBillingPortal: vi.fn(),
    createSharedRecipe: apiMocks.createSharedRecipe,
    deleteAccount: vi.fn(),
    deleteShoppingItems: vi.fn(),
    deleteSharedRecipe: apiMocks.deleteSharedRecipe,
    extractRecipe: vi.fn(),
    getAuthConfig: vi.fn(),
    getHousehold: apiMocks.getHousehold,
    getSession: vi.fn(),
    getShoppingList: vi.fn(),
    getSharedRecipes: apiMocks.getSharedRecipes,
    getWebBillingAvailability: vi.fn(),
    leaveHousehold: vi.fn(),
    logout: vi.fn(),
    removeHouseholdMember: vi.fn(),
    requestLoginCode: vi.fn(),
    sendAnalyticsEvents: vi.fn(),
    updateAccountProfile: vi.fn(),
    upsertShoppingItems: vi.fn(),
    updateSharedRecipe: apiMocks.updateSharedRecipe,
    verifyLoginCode: vi.fn()
  }) as ExtractorApiClient;

let latestSavedRecipes: ReturnType<typeof useSavedRecipes> | null = null;

const Probe = () => {
  latestSavedRecipes = useSavedRecipes();
  return null;
};

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const renderProvider = async () => {
  let renderer: ReturnType<typeof create> | null = null;

  await act(async () => {
    renderer = create(
      <SavedRecipesProvider>
        <Probe />
      </SavedRecipesProvider>
    );
    await flushAsyncWork();
  });

  await act(async () => {
    await flushAsyncWork();
  });

  return renderer;
};

const storeSavedRecipes = (records: ReturnType<typeof buildSavedRecipes>) => {
  asyncStorageMocks.getItem.mockImplementation((key: string) =>
    Promise.resolve(key === "linkdish.savedRecipes" ? JSON.stringify(records) : null)
  );
};

beforeEach(() => {
  latestSavedRecipes = null;
  accountState.getAuthHeaders.mockReset();
  accountState.getAuthHeaders.mockResolvedValue({});
  accountState.isSignedIn = false;
  accountState.sessionToken = null;
  accountState.user = null;
  billingState.tier = "free";

  for (const mock of Object.values(apiMocks)) {
    mock.mockReset();
  }

  asyncStorageMocks.getItem.mockReset();
  asyncStorageMocks.removeItem.mockReset();
  asyncStorageMocks.setItem.mockReset();
  asyncStorageMocks.getItem.mockResolvedValue(null);
  asyncStorageMocks.removeItem.mockResolvedValue(undefined);
  asyncStorageMocks.setItem.mockResolvedValue(undefined);
  analyticsMocks.trackMobileEvent.mockReset();

  apiMocks.createExtractorApiClient.mockReturnValue(createMockClient());
  apiMocks.createSharedRecipe.mockResolvedValue({
    recipe: buildSharedRecipe(500, "shared_recipe_created")
  });
  apiMocks.deleteSharedRecipe.mockResolvedValue({ status: "deleted" });
  apiMocks.getHousehold.mockResolvedValue({ household: null });
  apiMocks.getSharedRecipes.mockResolvedValue({ recipes: [] });
  apiMocks.updateSharedRecipe.mockResolvedValue({
    recipe: buildSharedRecipe(501, "shared_recipe_updated")
  });
});

describe("SavedRecipesProvider household save entitlement", () => {
  it("increments a saved recipe's cooking count in persistent state", async () => {
    const storedRecipe = buildSavedRecipes(1)[0]!;
    storeSavedRecipes([storedRecipe]);

    await renderProvider();

    await act(async () => {
      expect(latestSavedRecipes?.incrementRecipeTimesCooked(storedRecipe.id)).toBe(true);
      await flushAsyncWork();
    });

    expect(latestSavedRecipes?.savedRecipes[0]?.timesCooked).toBe(1);
    expect(latestSavedRecipes?.incrementRecipeTimesCooked("missing-recipe")).toBe(false);
    expect(
      asyncStorageMocks.setItem.mock.calls.some(
        ([key, value]) =>
          key === "linkdish.savedRecipes" &&
          typeof value === "string" &&
          value.includes('"timesCooked":1')
      )
    ).toBe(true);
  });

  it("seeds starter recipes once for a first empty library", async () => {
    await renderProvider();

    expect(latestSavedRecipes?.hasLoadedSavedRecipes).toBe(true);
    expect(latestSavedRecipes?.savedRecipes).toHaveLength(3);
    expect(latestSavedRecipes?.savedRecipes.every((recipe) => recipe.isStarter)).toBe(true);
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.starterRecipesSeeded.v1",
      "true"
    );
  });

  it("marks returning saved-recipe libraries as seeded without adding starters", async () => {
    const storedRecipes = buildSavedRecipes(2);
    storeSavedRecipes(storedRecipes);

    await renderProvider();

    expect(latestSavedRecipes?.savedRecipes).toHaveLength(2);
    expect(latestSavedRecipes?.savedRecipes.some((recipe) => recipe.isStarter)).toBe(false);
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.starterRecipesSeeded.v1",
      "true"
    );
  });

  it("lets active household members save and duplicate personal copies past the free cap", async () => {
    const storedRecipes = buildSavedRecipes(15);
    const sharedRecipe = buildSharedRecipe(100);
    storeSavedRecipes(storedRecipes);
    accountState.isSignedIn = true;
    accountState.sessionToken = "session-token";
    accountState.user = {
      email: "member@example.com",
      id: "member_1"
    };
    apiMocks.getHousehold.mockResolvedValue({ household: buildHousehold() });
    apiMocks.getSharedRecipes.mockResolvedValue({ recipes: [sharedRecipe] });

    await renderProvider();

    expect(latestSavedRecipes?.hasLoadedSharedRecipes).toBe(true);
    expect(latestSavedRecipes?.canUseSharedRecipeBook).toBe(true);
    expect(latestSavedRecipes?.savedRecipes).toHaveLength(15);
    expect(latestSavedRecipes?.getSaveLimitStatus()).toEqual({ allowed: true });

    let bothResult: Awaited<
      ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipeToTargets"]>
    >;
    let personalCloneResult: ReturnType<NonNullable<typeof latestSavedRecipes>["cloneRecipe"]>;
    let sharedCloneResult: ReturnType<NonNullable<typeof latestSavedRecipes>["cloneSharedRecipe"]>;

    await act(async () => {
      bothResult = await latestSavedRecipes!.saveRecipeToTargets(buildSuccessState(20), "both");
      personalCloneResult = latestSavedRecipes!.cloneRecipe(storedRecipes[0]!.id);
      sharedCloneResult = latestSavedRecipes!.cloneSharedRecipe(sharedRecipe.id);
      await flushAsyncWork();
    });

    expect(bothResult!).toMatchObject({
      allowed: true,
      saved: true,
      sharedRecipeId: "shared_recipe_created"
    });
    expect(personalCloneResult!).toMatchObject({ allowed: true, saved: true });
    expect(sharedCloneResult!).toMatchObject({ allowed: true, saved: true });
    expect(apiMocks.createSharedRecipe).toHaveBeenCalledTimes(1);
    expect(analyticsMocks.trackMobileEvent).toHaveBeenCalledWith({
      eventName: "family_shared",
      routeOrScreen: "recipe",
      properties: {
        recipe_count: 1,
        share_scope: "household"
      }
    });
    expect(latestSavedRecipes?.savedRecipes).toHaveLength(18);
  });

  it("keeps the free cap for signed-in users without active household access", async () => {
    storeSavedRecipes(buildSavedRecipes(15));
    accountState.isSignedIn = true;
    accountState.sessionToken = "session-token";
    accountState.user = {
      email: "member@example.com",
      id: "member_1"
    };
    apiMocks.getHousehold.mockResolvedValue({ household: null });

    await renderProvider();

    expect(latestSavedRecipes?.hasLoadedSharedRecipes).toBe(true);
    expect(latestSavedRecipes?.canUseSharedRecipeBook).toBe(false);
    expect(latestSavedRecipes?.getSaveLimitStatus()).toMatchObject({ allowed: false });

    let result: Awaited<ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipeToTargets"]>>;

    await act(async () => {
      result = await latestSavedRecipes!.saveRecipeToTargets(buildSuccessState(20), "personal");
      await flushAsyncWork();
    });

    expect(result!).toMatchObject({ allowed: false, saved: false });
    expect(apiMocks.createSharedRecipe).not.toHaveBeenCalled();
    expect(latestSavedRecipes?.savedRecipes).toHaveLength(15);
  });

  it("does not unlock saves when household lookup succeeds but shared-book access fails", async () => {
    storeSavedRecipes(buildSavedRecipes(15));
    accountState.isSignedIn = true;
    accountState.sessionToken = "session-token";
    accountState.user = {
      email: "member@example.com",
      id: "member_1"
    };
    apiMocks.getHousehold.mockResolvedValue({ household: buildHousehold() });
    apiMocks.getSharedRecipes.mockRejectedValue(
      new Error("An active LinkDish Family household is required.")
    );

    await renderProvider();

    expect(latestSavedRecipes?.hasLoadedSharedRecipes).toBe(true);
    expect(latestSavedRecipes?.canUseSharedRecipeBook).toBe(false);
    expect(latestSavedRecipes?.sharedRecipeError).toBe(
      "An active LinkDish Family household is required."
    );
    expect(latestSavedRecipes?.getSaveLimitStatus()).toMatchObject({ allowed: false });
  });

  it("lets free users save 15 personal recipes and blocks the 16th", async () => {
    storeSavedRecipes(buildSavedRecipes(14));

    await renderProvider();

    let fifteenthResult: Awaited<ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]>>;
    let sixteenthResult: Awaited<ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]>>;

    await act(async () => {
      fifteenthResult = await latestSavedRecipes!.saveRecipe(buildSuccessState(15));
      await flushAsyncWork();
    });

    await act(async () => {
      sixteenthResult = await latestSavedRecipes!.saveRecipe(buildSuccessState(16));
      await flushAsyncWork();
    });

    expect(fifteenthResult!).toMatchObject({ allowed: true, saved: true });
    expect(sixteenthResult!).toMatchObject({
      allowed: false,
      message: "Your free Cookbook holds up to 15 personal recipes. Upgrade for unlimited saves.",
      saved: false
    });
    expect(latestSavedRecipes?.savedRecipes).toHaveLength(15);
  });

  it("excludes seeded starter recipes from the free personal save cap", async () => {
    const starterRecords = createStarterRecipeSeedRecords("2026-04-19T11:00:00.000Z").map(
      starterRecipeSeedRecordToSavedRecipeRecord
    );
    storeSavedRecipes([...starterRecords, ...buildSavedRecipes(14)]);

    await renderProvider();

    let fifteenthPersonalResult: Awaited<
      ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]>
    >;

    await act(async () => {
      fifteenthPersonalResult = await latestSavedRecipes!.saveRecipe(buildSuccessState(30));
      await flushAsyncWork();
    });

    expect(fifteenthPersonalResult!).toMatchObject({ allowed: true, saved: true });
    expect(latestSavedRecipes?.savedRecipes.filter((recipe) => !recipe.isStarter)).toHaveLength(15);
    expect(latestSavedRecipes?.savedRecipes.filter((recipe) => recipe.isStarter)).toHaveLength(3);
  });
});
