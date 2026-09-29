import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSaveImport } from "./use-save-import";

import type { SaveRecipeInput } from "../library/saved-recipe-store";
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
vi.mock("../../lib/delight-events", () => ({ requestSaveFeedback: vi.fn() }));
vi.mock("../install/install-eligibility", () => ({ markRecipeSaved: vi.fn() }));
vi.mock("../shopping/shopping-sync", () => ({ useShoppingAccount: () => ({ mode: "household" }) }));
vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: vi.fn() })
}));
vi.mock("../library/saved-recipe-store", () => ({
  ...store,
  SavedRecipeLimitError: class SavedRecipeLimitError extends Error {}
}));

const input = {
  recipe: { title: "Soup" },
  sourceUrl: "https://example.com/soup"
} as unknown as SaveRecipeInput;

const savedRecipe = {
  id: "recipe_soup",
  recipe: { title: "Soup" },
  sourceUrl: "https://example.com/soup",
  sync: { status: "local_only" }
} as unknown as WebSavedRecipe;

const userA: TestUser = { billingPlan: "plus", email: "a@example.com", id: "user_a" };
const userB: TestUser = { billingPlan: "plus", email: "b@example.com", id: "user_b" };

describe("useSaveImport", () => {
  beforeEach(() => {
    auth.isAuthenticated = true;
    auth.user = userA;
    for (const mock of Object.values(store)) {
      mock.mockReset();
    }
    store.generateDeterministicId.mockResolvedValue("recipe_soup");
  });

  it("shares a saved import with the household as the account that saved it", async () => {
    store.saveRecipe.mockResolvedValue({ recipe: savedRecipe, success: true });
    store.syncRecipeToHousehold.mockResolvedValue({
      ...savedRecipe,
      sync: { status: "synced" }
    });
    const { result } = renderHook(() => useSaveImport(input));

    await act(async () => {
      await result.current.save();
    });

    await waitFor(() => expect(result.current.household).toBe("shared"));
  });

  it("doesn't share it into the household of an account that signed in while it saved", async () => {
    let finishSave: (value: unknown) => void = () => undefined;
    store.saveRecipe.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      })
    );
    const { rerender, result } = renderHook(() => useSaveImport(input));

    let saving: Promise<unknown> = Promise.resolve();
    act(() => {
      saving = result.current.save();
    });
    // Another account signs straight in (a cached user replaced once Clerk answers).
    auth.user = userB;
    rerender();
    await act(async () => {
      finishSave({ recipe: savedRecipe, success: true });
      await saving;
    });

    expect(result.current.status).toBe("saved");
    expect(store.syncRecipeToHousehold).not.toHaveBeenCalled();
    expect(result.current.household).toBe("none");
  });

  it("doesn't share it as a signed-out visitor after signing out while it saved", async () => {
    let finishSave: (value: unknown) => void = () => undefined;
    store.saveRecipe.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      })
    );
    const { rerender, result } = renderHook(() => useSaveImport(input));

    let saving: Promise<unknown> = Promise.resolve();
    act(() => {
      saving = result.current.save();
    });
    auth.isAuthenticated = false;
    auth.user = null;
    rerender();
    await act(async () => {
      finishSave({ recipe: savedRecipe, success: true });
      await saving;
    });

    expect(store.syncRecipeToHousehold).not.toHaveBeenCalled();
  });

  it("stops a share under way once another account signs in, and reports nothing for it", async () => {
    let finishShare: (value: unknown) => void = () => undefined;
    store.saveRecipe.mockResolvedValue({ recipe: savedRecipe, success: true });
    store.syncRecipeToHousehold.mockReturnValue(
      new Promise((resolve) => {
        finishShare = resolve;
      })
    );
    const { rerender, result } = renderHook(() => useSaveImport(input));

    await act(async () => {
      await result.current.save();
    });
    const [, options] = store.syncRecipeToHousehold.mock.calls[0] as [
      WebSavedRecipe,
      { isCurrent: () => boolean }
    ];
    expect(options.isCurrent()).toBe(true);

    auth.user = userB;
    rerender();

    // The share stops before its next request; nothing it answers lands on the next account.
    expect(options.isCurrent()).toBe(false);
    await act(async () => {
      finishShare({ ...savedRecipe, sync: { status: "synced" } });
      await Promise.resolve();
    });
    expect(result.current.household).toBe("none");
  });
});
