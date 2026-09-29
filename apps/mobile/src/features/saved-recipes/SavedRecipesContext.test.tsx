import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain";
import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SAVED_RECIPES_PERSIST_DEBOUNCE_MS,
  SavedRecipesProvider,
  useSavedRecipes
} from "./SavedRecipesContext";
import {
  cloneSavedRecipeRecord,
  createSavedRecipeRecord,
  starterRecipeSeedRecordToSavedRecipeRecord
} from "./store";

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

const fileSystemMocks = vi.hoisted(() => ({
  deleted: [] as string[],
  existing: new Set<string>(),
  writes: [] as Array<{ content: string; uri: string }>
}));

const appStateMocks = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateMocks.listeners.push(listener);
      return {
        remove: () => {
          appStateMocks.listeners = appStateMocks.listeners.filter((entry) => entry !== listener);
        }
      };
    }
  }
}));

vi.mock("expo-file-system", () => {
  class Directory {
    public exists = false;

    public uri: string;

    public constructor(...parts: Array<{ uri: string } | string>) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri).replace(/\/+$/u, ""))
        .join("/");
    }

    public create() {
      this.exists = true;
    }
  }

  class File {
    public uri: string;

    public constructor(...parts: Array<{ uri: string } | string>) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri).replace(/\/+$/u, ""))
        .join("/");
    }

    public create() {
      // no-op in tests
    }

    public get exists() {
      return fileSystemMocks.existing.has(this.uri);
    }

    public delete() {
      fileSystemMocks.existing.delete(this.uri);
      fileSystemMocks.deleted.push(this.uri);
    }

    public write(content: string) {
      fileSystemMocks.writes.push({ content, uri: this.uri });
    }
  }

  return {
    Directory,
    File,
    Paths: {
      document: { uri: "file:///documents/" }
    }
  };
});

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
    extractRecipeFromText: vi.fn(),
    getAuthConfig: vi.fn(),
    getBillingUsage: vi.fn(),
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

const cookbookWritesOf = () =>
  asyncStorageMocks.setItem.mock.calls
    .filter(([key]) => key === "linkdish.savedRecipes")
    .map(([, value]) => String(value));

const settlePersistence = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVED_RECIPES_PERSIST_DEBOUNCE_MS);
  });
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

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  latestSavedRecipes = null;
  appStateMocks.listeners = [];
  fileSystemMocks.deleted.splice(0);
  fileSystemMocks.existing.clear();
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
  fileSystemMocks.writes.splice(0);

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

    await settlePersistence();

    expect(cookbookWritesOf().some((value) => value.includes('"timesCooked":1'))).toBe(true);
  });

  it("coalesces rapid small edits into one cookbook write", async () => {
    const storedRecipe = buildSavedRecipes(1)[0]!;
    storeSavedRecipes([storedRecipe]);

    await renderProvider();
    await settlePersistence();

    // Loading an unchanged cookbook does not write it back.
    expect(cookbookWritesOf()).toHaveLength(0);

    await act(async () => {
      latestSavedRecipes!.incrementRecipeTimesCooked(storedRecipe.id);
      latestSavedRecipes!.incrementRecipeTimesCooked(storedRecipe.id);
      latestSavedRecipes!.setRecipeFavorite(storedRecipe.id, true);
      await flushAsyncWork();
    });

    expect(cookbookWritesOf()).toHaveLength(0);

    await settlePersistence();

    const writes = cookbookWritesOf();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"timesCooked":2');
    expect(writes[0]).toContain('"favorite":true');
  });

  it("writes pending edits immediately when the app goes to the background", async () => {
    const storedRecipe = buildSavedRecipes(1)[0]!;
    storeSavedRecipes([storedRecipe]);

    await renderProvider();

    await act(async () => {
      latestSavedRecipes!.setRecipeFavorite(storedRecipe.id, true);
      await flushAsyncWork();
    });

    await act(async () => {
      appStateMocks.listeners.forEach((listener) => listener("background"));
      await flushAsyncWork();
    });

    expect(cookbookWritesOf().some((value) => value.includes('"favorite":true'))).toBe(true);
  });

  it("does not write the cookbook a second time after an explicit save", async () => {
    storeSavedRecipes(buildSavedRecipes(1));

    await renderProvider();

    await act(async () => {
      await latestSavedRecipes!.saveRecipe(buildSuccessState(7));
      await flushAsyncWork();
    });
    await settlePersistence();

    expect(cookbookWritesOf()).toHaveLength(1);
    expect(latestSavedRecipes?.savedRecipes).toHaveLength(2);
  });

  it("keeps the heart when a saved recipe is saved again", async () => {
    storeSavedRecipes([]);

    await renderProvider();

    let firstId: string | undefined;

    await act(async () => {
      firstId = (await latestSavedRecipes!.saveRecipe(buildSuccessState(8))).recipeId;
      await flushAsyncWork();
    });
    await act(async () => {
      latestSavedRecipes!.setRecipeFavorite(firstId!, true);
      await latestSavedRecipes!.saveRecipe(buildSuccessState(8));
      await flushAsyncWork();
    });

    expect(latestSavedRecipes?.getSavedRecipeById(firstId!)?.favorite).toBe(true);
  });

  it("deletes a removed recipe's scan files unless a copy still uses them", async () => {
    const shared = "file:///documents/recipe-scans/saved-a-0.jpg";
    const ownOnly = "file:///documents/recipe-scans/saved-a-1.jpg";
    const original = {
      ...buildSavedRecipes(1)[0]!,
      sourceImages: [
        { mimeType: "image/jpeg" as const, uri: shared },
        { mimeType: "image/jpeg" as const, uri: ownOnly }
      ]
    };
    const copy = {
      ...cloneSavedRecipeRecord([original], original, "2026-04-19T13:00:00.000Z"),
      sourceImages: [{ mimeType: "image/jpeg" as const, uri: shared }]
    };
    fileSystemMocks.existing.add(shared);
    fileSystemMocks.existing.add(ownOnly);
    storeSavedRecipes([original, copy]);

    await renderProvider();

    await act(async () => {
      latestSavedRecipes!.removeRecipe(original.id);
      await flushAsyncWork();
    });

    expect(latestSavedRecipes?.savedRecipes.map((recipe) => recipe.id)).toEqual([copy.id]);
    expect(fileSystemMocks.deleted).toEqual([ownOnly]);
    // The removal is written before any file is deleted.
    expect(
      (JSON.parse(cookbookWritesOf().at(-1) ?? "[]") as Array<{ id: string }>).map(
        (recipe) => recipe.id
      )
    ).toEqual([copy.id]);

    await act(async () => {
      latestSavedRecipes!.removeRecipe(copy.id);
      await flushAsyncWork();
    });

    expect(fileSystemMocks.deleted).toEqual([ownOnly, shared]);
  });

  it("keeps the context value stable across unrelated re-renders", async () => {
    storeSavedRecipes(buildSavedRecipes(2));
    const renderer = (await renderProvider()) as unknown as ReturnType<typeof create>;
    const firstValue = latestSavedRecipes;

    await act(async () => {
      renderer.update(
        <SavedRecipesProvider>
          <Probe />
        </SavedRecipesProvider>
      );
      await flushAsyncWork();
    });

    expect(latestSavedRecipes).toBe(firstValue);
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

  describe("when a saved recipe changes while it is saved again", () => {
    /** The cookbook write waits until `finish`, as a slow AsyncStorage write would. */
    const holdNextCookbookWrite = () => {
      let finish: () => void = () => undefined;
      asyncStorageMocks.setItem.mockImplementationOnce((key: string) =>
        key === "linkdish.savedRecipes"
          ? new Promise<void>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve()
      );
      return () => finish();
    };

    const resaveFirst = async () => {
      const stored = buildSavedRecipes(1);
      storeSavedRecipes(stored);
      await renderProvider();
      const [record] = latestSavedRecipes!.savedRecipes;
      const finishWrite = holdNextCookbookWrite();
      let pending: ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]> =
        Promise.resolve({ allowed: true, saved: true });

      await act(async () => {
        // The same link imported again: the save replaces the stored recipe.
        pending = latestSavedRecipes!.saveRecipe(buildSuccessState(0));
        await flushAsyncWork();
      });

      return { finishWrite, pending: () => pending, record: record! };
    };

    it("keeps a favorite and a cook made while the recipe was written", async () => {
      const { finishWrite, pending, record } = await resaveFirst();

      act(() => {
        latestSavedRecipes!.setRecipeFavorite(record.id, true);
        latestSavedRecipes!.incrementRecipeTimesCooked(record.id);
      });
      await act(async () => {
        finishWrite();
        await pending();
      });

      expect(latestSavedRecipes?.savedRecipes).toHaveLength(1);
      expect(latestSavedRecipes?.savedRecipes[0]).toMatchObject({
        favorite: true,
        id: record.id,
        timesCooked: (record.timesCooked ?? 0) + 1
      });
    });

    it("doesn't bring back a recipe deleted while it was written", async () => {
      const { finishWrite, pending, record } = await resaveFirst();

      act(() => {
        latestSavedRecipes!.removeRecipe(record.id);
      });
      let result: Awaited<ReturnType<typeof pending>> | undefined;
      await act(async () => {
        finishWrite();
        result = await pending();
      });

      expect(result).toMatchObject({ saved: false });
      expect(latestSavedRecipes?.savedRecipes).toEqual([]);
    });
  });

  describe("when another account signs in while a recipe is saving", () => {
    /** The cookbook write waits until `finish`, as a slow AsyncStorage write would. */
    const holdCookbookWrite = () => {
      let finish: () => void = () => undefined;
      asyncStorageMocks.setItem.mockImplementation((key: string) =>
        key === "linkdish.savedRecipes"
          ? new Promise<void>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve()
      );
      return () => finish();
    };

    const signInAsMember = () => {
      accountState.isSignedIn = true;
      accountState.sessionToken = "session-token";
      accountState.user = { email: "member@example.com", id: "member_1" };
      apiMocks.getHousehold.mockResolvedValue({ household: buildHousehold() });
    };

    const switchAccount = async (renderer: ReturnType<typeof create> | null) => {
      accountState.user = { email: "other@example.com", id: "other_1" };
      await act(async () => {
        renderer?.update(
          <SavedRecipesProvider>
            <Probe />
          </SavedRecipesProvider>
        );
        await flushAsyncWork();
      });
    };

    it("saves it on this phone without sharing it into the next account's household", async () => {
      signInAsMember();
      const renderer = await renderProvider();
      expect(latestSavedRecipes?.canUseSharedRecipeBook).toBe(true);
      const finishWrite = holdCookbookWrite();

      let pending: ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipeToTargets"]>;
      await act(async () => {
        pending = latestSavedRecipes!.saveRecipeToTargets(buildSuccessState(30), "both");
        await flushAsyncWork();
      });

      await switchAccount(renderer);
      let result: Awaited<typeof pending> | undefined;
      await act(async () => {
        finishWrite();
        result = await pending!;
      });

      expect(result).toMatchObject({
        allowed: true,
        message:
          "Saved to your personal book, but Family sharing failed: you switched accounts while it was saving.",
        saved: true
      });
      expect(apiMocks.createSharedRecipe).not.toHaveBeenCalled();
    });

    it("stops sharing the whole book once another account signs in", async () => {
      storeSavedRecipes(buildSavedRecipes(3));
      signInAsMember();
      const renderer = await renderProvider();
      let finishFirst: (value: unknown) => void = () => undefined;
      apiMocks.createSharedRecipe.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      );

      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = latestSavedRecipes!.setShareMode("all");
        await flushAsyncWork();
      });
      await switchAccount(renderer);
      await act(async () => {
        finishFirst({ recipe: buildSharedRecipe(600, "shared_first") });
        await pending;
      });

      // The recipe already on its way was shared as the member; none as the next account.
      expect(apiMocks.createSharedRecipe).toHaveBeenCalledTimes(1);
      expect(latestSavedRecipes?.shareMode).not.toBe("all");
    });

    it("never renders the last account's Family recipes for the next one, even before its refresh", async () => {
      signInAsMember();
      const memberRecipe = buildSharedRecipe(710, "member_recipe");
      apiMocks.getSharedRecipes
        .mockResolvedValueOnce({ recipes: [memberRecipe] })
        .mockImplementation(() => new Promise(() => undefined));
      const renders: Array<{ loaded: boolean; shared: string[]; user: string | undefined }> = [];
      const RenderLog = () => {
        const value = useSavedRecipes();
        renders.push({
          loaded: value.hasLoadedSharedRecipes,
          shared: value.sharedRecipes.map((recipe) => recipe.id),
          user: accountState.user?.id
        });
        return null;
      };
      let renderer: ReturnType<typeof create> | null = null;

      await act(async () => {
        renderer = create(
          <SavedRecipesProvider>
            <RenderLog />
          </SavedRecipesProvider>
        );
        await flushAsyncWork();
      });
      await act(async () => {
        await flushAsyncWork();
      });
      expect(renders.at(-1)).toMatchObject({ loaded: true, shared: ["member_recipe"] });

      // Another account signs straight in; its Family list is still loading.
      accountState.user = { email: "other@example.com", id: "other_1" };
      await act(async () => {
        renderer!.update(
          <SavedRecipesProvider>
            <RenderLog />
          </SavedRecipesProvider>
        );
        await flushAsyncWork();
      });

      const afterSwitch = renders.filter((render) => render.user === "other_1");
      expect(afterSwitch.length).toBeGreaterThan(0);
      expect(afterSwitch.every((render) => render.shared.length === 0 && !render.loaded)).toBe(
        true
      );
    });

    it("never shows the last account's Family recipes once its late answer lands", async () => {
      signInAsMember();
      const memberRecipe = buildSharedRecipe(700, "member_recipe");
      const otherRecipe = buildSharedRecipe(701, "other_recipe");
      let finishMemberList: (value: unknown) => void = () => undefined;
      apiMocks.getSharedRecipes
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishMemberList = resolve;
            })
        )
        .mockResolvedValue({ recipes: [otherRecipe] });
      const renderer = await renderProvider();

      await switchAccount(renderer);
      expect(latestSavedRecipes?.sharedRecipes).toEqual([otherRecipe]);

      await act(async () => {
        finishMemberList({ recipes: [memberRecipe] });
        await flushAsyncWork();
      });

      expect(latestSavedRecipes?.sharedRecipes).toEqual([otherRecipe]);
    });

    it("keeps a share that finished after a switch out of the next account's Family", async () => {
      storeSavedRecipes(buildSavedRecipes(1));
      signInAsMember();
      const renderer = await renderProvider();
      const [record] = latestSavedRecipes!.savedRecipes;
      let finishShare: (value: unknown) => void = () => undefined;
      apiMocks.createSharedRecipe.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishShare = resolve;
          })
      );

      let pending: ReturnType<NonNullable<typeof latestSavedRecipes>["shareRecipe"]> =
        Promise.resolve({ allowed: true, saved: true });
      await act(async () => {
        pending = latestSavedRecipes!.shareRecipe(record!.id);
        await flushAsyncWork();
      });
      await switchAccount(renderer);
      let result: Awaited<typeof pending> | undefined;
      await act(async () => {
        finishShare({ recipe: buildSharedRecipe(702, "member_share") });
        result = await pending;
      });

      expect(result).toMatchObject({ saved: false });
      expect(latestSavedRecipes?.sharedRecipes.map((entry) => entry.id)).not.toContain(
        "member_share"
      );
      expect(latestSavedRecipes?.savedRecipes[0]?.sharedRecipeId).toBeUndefined();
    });

    it("doesn't share a recipe by the next account's share-everything setting", async () => {
      signInAsMember();
      asyncStorageMocks.getItem.mockImplementation((key: string) =>
        Promise.resolve(key.startsWith("linkdish.recipeBookShareMode") ? "all" : null)
      );
      const renderer = await renderProvider();
      expect(latestSavedRecipes?.shareMode).toBe("all");
      const finishWrite = holdCookbookWrite();

      let pending: ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]>;
      await act(async () => {
        pending = latestSavedRecipes!.saveRecipe(buildSuccessState(31));
        await flushAsyncWork();
      });

      await switchAccount(renderer);
      await act(async () => {
        finishWrite();
        await pending!;
      });

      expect(apiMocks.createSharedRecipe).not.toHaveBeenCalled();
    });
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

  it("keeps scan photos out of the cookbook storage blob", async () => {
    await renderProvider();

    let result: Awaited<ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]>>;

    await act(async () => {
      result = await latestSavedRecipes!.saveRecipe({
        ...buildSuccessState(42),
        sourceImages: [{ mimeType: "image/jpeg", uri: "data:image/jpeg;base64,SCANBYTES" }]
      });
      await flushAsyncWork();
    });

    expect(result!).toMatchObject({ allowed: true, saved: true });
    expect(fileSystemMocks.writes).toHaveLength(1);
    expect(fileSystemMocks.writes[0]?.content).toBe("SCANBYTES");

    const savedImage = latestSavedRecipes?.savedRecipes[0]?.sourceImages?.[0];
    expect(savedImage?.uri.startsWith("file:///documents/")).toBe(true);

    const cookbookWrites = asyncStorageMocks.setItem.mock.calls.filter(
      ([key]) => key === "linkdish.savedRecipes"
    );
    expect(cookbookWrites.length).toBeGreaterThan(0);

    for (const [, value] of cookbookWrites) {
      expect(String(value)).not.toContain("SCANBYTES");
      expect(String(value)).not.toContain("base64");
    }
  });

  it("migrates legacy base64 scan photos onto the filesystem when loading", async () => {
    const storedRecipe = buildSavedRecipes(1)[0]!;
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(
        key === "linkdish.savedRecipes"
          ? JSON.stringify([
              {
                ...storedRecipe,
                sourceImages: [
                  { dataUrl: "data:image/png;base64,LEGACYBYTES", mimeType: "image/png" }
                ]
              }
            ])
          : key === "linkdish.starterRecipesSeeded.v1"
            ? "true"
            : null
      )
    );

    await renderProvider();
    await settlePersistence();

    expect(fileSystemMocks.writes).toHaveLength(1);
    expect(fileSystemMocks.writes[0]?.content).toBe("LEGACYBYTES");
    expect(latestSavedRecipes?.savedRecipes[0]?.sourceImages?.[0]?.uri.startsWith("file://")).toBe(
      true
    );

    const cookbookWrites = asyncStorageMocks.setItem.mock.calls.filter(
      ([key]) => key === "linkdish.savedRecipes"
    );
    expect(cookbookWrites.length).toBeGreaterThan(0);

    for (const [, value] of cookbookWrites) {
      expect(String(value)).not.toContain("LEGACYBYTES");
    }
  });

  it("reports a failure instead of pretending a recipe was saved", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await renderProvider();

    asyncStorageMocks.setItem.mockImplementation((key: string) =>
      key === "linkdish.savedRecipes"
        ? Promise.reject(new Error("Row too big to fit into CursorWindow"))
        : Promise.resolve(undefined)
    );

    let result: Awaited<ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]>>;

    await act(async () => {
      result = await latestSavedRecipes!.saveRecipe(buildSuccessState(43));
      await flushAsyncWork();
    });

    expect(result!).toMatchObject({ reason: "persist_failed", saved: false });
    expect(result!.message).toBeTruthy();
    expect(
      latestSavedRecipes?.savedRecipes.some(
        (recipe) => recipe.recipe.sourceUrl === buildSuccessState(43).recipe.sourceUrl
      )
    ).toBe(false);
  });

  it("does not overwrite a corrupt cookbook blob with an empty cookbook", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const corruptBlob = '[{"savedAt":"2026-04-19T12:00:00.000Z","recipe":{"title":"Soup"';
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(
        key === "linkdish.savedRecipes"
          ? corruptBlob
          : key === "linkdish.starterRecipesSeeded.v1"
            ? "true"
            : null
      )
    );

    await renderProvider();

    expect(latestSavedRecipes?.hasLoadedSavedRecipes).toBe(true);
    expect(latestSavedRecipes?.savedRecipes).toHaveLength(0);
    expect(
      asyncStorageMocks.setItem.mock.calls.some(([key]) => key === "linkdish.savedRecipes")
    ).toBe(false);
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.savedRecipes.corrupt.v1",
      corruptBlob
    );

    await act(async () => {
      await latestSavedRecipes!.saveRecipe(buildSuccessState(44));
      await flushAsyncWork();
    });

    expect(
      asyncStorageMocks.setItem.mock.calls.some(([key]) => key === "linkdish.savedRecipes")
    ).toBe(true);
  });

  it("returns a typed reason when the free save limit is reached", async () => {
    storeSavedRecipes(buildSavedRecipes(15));

    await renderProvider();

    let saveResult: Awaited<ReturnType<NonNullable<typeof latestSavedRecipes>["saveRecipe"]>>;
    let cloneResult: ReturnType<NonNullable<typeof latestSavedRecipes>["cloneRecipe"]>;

    await act(async () => {
      saveResult = await latestSavedRecipes!.saveRecipe(buildSuccessState(60));
      cloneResult = latestSavedRecipes!.cloneRecipe(latestSavedRecipes!.savedRecipes[0]!.id);
      await flushAsyncWork();
    });

    expect(latestSavedRecipes?.getSaveLimitStatus()).toMatchObject({
      allowed: false,
      reason: "save_limit_reached"
    });
    expect(saveResult!).toMatchObject({
      allowed: false,
      reason: "save_limit_reached",
      saved: false
    });
    expect(cloneResult!).toMatchObject({
      allowed: false,
      reason: "save_limit_reached",
      saved: false
    });
  });
});
