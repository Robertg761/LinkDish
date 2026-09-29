import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSaveFeaturedRecipe } from "./use-save-featured-recipe";

import type { FeaturedRecipe } from "./types";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

type TestUser = { billingPlan: "free" | "plus"; email: string; id: string };

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  user: null as TestUser | null
}));

const store = vi.hoisted(() => ({
  forceSaveRecipe: vi.fn(),
  generateDeterministicId: vi.fn(),
  saveRecipe: vi.fn(),
  syncRecipeToHousehold: vi.fn()
}));

vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../analytics/client", () => ({ trackWebV2AnalyticsEvent: vi.fn() }));
vi.mock("../../data/library-store", () => ({ useSavedRecipe: () => ({ recipe: undefined }) }));
vi.mock("../../lib/delight-events", () => ({ requestSaveFeedback: vi.fn() }));
vi.mock("../install/install-eligibility", () => ({ markRecipeSaved: vi.fn() }));
vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: vi.fn() })
}));
vi.mock("../library/saved-recipe-store", () => store);

const featured = {
  extraction: {},
  recipe: { title: "Soup" },
  sourceUrl: "https://example.com/soup"
} as unknown as FeaturedRecipe;

const savedRecipe = {
  id: "recipe_soup",
  recipe: { title: "Soup" },
  sync: { status: "local_only" }
} as unknown as WebSavedRecipe;

describe("useSaveFeaturedRecipe", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.user = { billingPlan: "plus", email: "a@example.com", id: "user_a" };
    for (const mock of Object.values(store)) {
      mock.mockReset();
    }
    store.generateDeterministicId.mockResolvedValue("recipe_soup");
  });

  it("shares a saved featured recipe with the household as the account that saved it", async () => {
    store.saveRecipe.mockResolvedValue({ recipe: savedRecipe, success: true });
    store.syncRecipeToHousehold.mockResolvedValue({ ...savedRecipe, sync: { status: "synced" } });
    const { result } = renderHook(() => useSaveFeaturedRecipe(featured));

    await act(async () => {
      await result.current.save();
    });

    expect(store.syncRecipeToHousehold).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("saved");
  });

  it("doesn't share it into the household of an account that signed in while it saved", async () => {
    let finishSave: (value: unknown) => void = () => undefined;
    store.saveRecipe.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      })
    );
    const { rerender, result } = renderHook(() => useSaveFeaturedRecipe(featured));

    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save();
    });
    // Another account signs straight in (a cached user replaced once Clerk answers).
    auth.user = { billingPlan: "plus", email: "b@example.com", id: "user_b" };
    rerender();
    await act(async () => {
      finishSave({ recipe: savedRecipe, success: true });
      await saving;
    });

    expect(store.syncRecipeToHousehold).not.toHaveBeenCalled();
    expect(result.current.status).toBe("saved");
    expect(result.current.syncWarning).toBe("");
  });

  it("stops a share under way once the account signs out, without warning the next visitor", async () => {
    let finishShare: (value: unknown) => void = () => undefined;
    store.saveRecipe.mockResolvedValue({ recipe: savedRecipe, success: true });
    store.syncRecipeToHousehold.mockReturnValue(
      new Promise((resolve) => {
        finishShare = resolve;
      })
    );
    const { rerender, result } = renderHook(() => useSaveFeaturedRecipe(featured));

    let saving: Promise<void> = Promise.resolve();
    await act(async () => {
      saving = result.current.save();
      await Promise.resolve();
    });
    const [, options] = store.syncRecipeToHousehold.mock.calls[0] as [
      WebSavedRecipe,
      { isCurrent: () => boolean }
    ];

    auth.isAuthenticated = false;
    auth.user = null;
    rerender();

    expect(options.isCurrent()).toBe(false);
    await act(async () => {
      finishShare({ ...savedRecipe, sync: { status: "sync_failed" } });
      await saving;
    });
    expect(result.current.syncWarning).toBe("");
  });
});
