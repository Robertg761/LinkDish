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
});
