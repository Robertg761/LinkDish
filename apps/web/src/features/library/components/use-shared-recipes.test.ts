import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSharedRecipesCacheForTests, useSharedRecipes } from "./use-shared-recipes";

import type { SharedRecipe } from "@linkdish/api-contracts";

const apiMocks = vi.hoisted(() => ({ getSharedRecipes: vi.fn() }));

vi.mock("../../../api/client", () => ({
  apiClient: { getSharedRecipes: apiMocks.getSharedRecipes },
  isExtractorApiError: (error: unknown) =>
    typeof error === "object" && error !== null && "statusCode" in error
}));

const sharedRecipe = { id: "shared-1" } as unknown as SharedRecipe;

describe("useSharedRecipes", () => {
  beforeEach(() => {
    resetSharedRecipesCacheForTests();
    apiMocks.getSharedRecipes.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits until the request would carry the account", async () => {
    apiMocks.getSharedRecipes.mockResolvedValue({ recipes: [sharedRecipe] });
    const { rerender, result } = renderHook(
      ({ credentialsKey }: { credentialsKey: string | null }) =>
        useSharedRecipes(true, "user_1", credentialsKey),
      { initialProps: { credentialsKey: null as string | null } }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("loading");
    expect(apiMocks.getSharedRecipes).not.toHaveBeenCalled();

    rerender({ credentialsKey: "clerk:user_1" });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.recipes).toEqual([sharedRecipe]);
    expect(apiMocks.getSharedRecipes).toHaveBeenCalledOnce();
  });

  it("loads again when Clerk signs in after a request went out without it", async () => {
    apiMocks.getSharedRecipes.mockRejectedValueOnce(
      Object.assign(new Error("Sign in"), { statusCode: 401 })
    );
    const { rerender, result } = renderHook(
      ({ credentialsKey }: { credentialsKey: string | null }) =>
        useSharedRecipes(true, "user_1", credentialsKey),
      { initialProps: { credentialsKey: "session:user_1" as string | null } }
    );

    await waitFor(() => expect(result.current.status).toBe("error"));

    apiMocks.getSharedRecipes.mockResolvedValue({ recipes: [sharedRecipe] });
    rerender({ credentialsKey: "clerk:user_1" });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.error).toBeNull();
    expect(result.current.recipes).toEqual([sharedRecipe]);
    expect(apiMocks.getSharedRecipes).toHaveBeenCalledTimes(2);
  });

  it("never shows one account's Family recipes to the next while its list loads", async () => {
    const otherRecipe = { id: "shared-2" } as unknown as SharedRecipe;
    let resolveNext: (value: { recipes: SharedRecipe[] }) => void = () => undefined;
    apiMocks.getSharedRecipes
      .mockResolvedValueOnce({ recipes: [sharedRecipe] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNext = resolve;
          })
      );
    const { rerender, result } = renderHook(
      ({ userId }: { userId: string }) => useSharedRecipes(true, userId, `clerk:${userId}`),
      { initialProps: { userId: "user_1" } }
    );
    await waitFor(() => expect(result.current.recipes).toEqual([sharedRecipe]));

    // Another account signs straight in (a cached user replaced once Clerk answers).
    rerender({ userId: "user_2" });

    expect(result.current.recipes).toEqual([]);
    expect(result.current.status).toBe("loading");

    await act(async () => {
      resolveNext({ recipes: [otherRecipe] });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.recipes).toEqual([otherRecipe]));
    expect(result.current.status).toBe("ready");
  });

  it("hides the last account's locked or failed state from the next account", async () => {
    apiMocks.getSharedRecipes
      .mockRejectedValueOnce(
        Object.assign(new Error("Family needs an active LinkDish Family household"), {
          details: { message: "An active LinkDish Family household is required." },
          statusCode: 403
        })
      )
      .mockImplementationOnce(() => new Promise(() => undefined));
    const { rerender, result } = renderHook(
      ({ userId }: { userId: string }) => useSharedRecipes(true, userId, `clerk:${userId}`),
      { initialProps: { userId: "user_1" } }
    );
    await waitFor(() => expect(result.current.accessBlocked).toBe(true));

    rerender({ userId: "user_2" });

    expect(result.current.accessBlocked).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("loading");
  });
});
