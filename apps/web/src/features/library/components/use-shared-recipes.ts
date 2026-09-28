import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient, isExtractorApiError } from "../../../api/client";

import type { SharedRecipe } from "@linkdish/api-contracts";

export const FAMILY_ACCESS_MESSAGE =
  "Family recipe sharing is available after you create or join an active Family household.";
export const FAMILY_LOAD_ERROR_MESSAGE =
  "Family recipes could not be loaded. Check your connection and try again.";

const getApiErrorMessage = (err: Error & { details?: unknown }): string => {
  if (
    err.details &&
    typeof err.details === "object" &&
    "message" in err.details &&
    typeof err.details.message === "string"
  ) {
    return err.details.message;
  }

  return err.message;
};

/** The account has no active Family household (or households are switched off). */
export const isSharedRecipeAccessError = (err: unknown): boolean => {
  if (!isExtractorApiError(err) || (err.statusCode !== 403 && err.statusCode !== 404)) {
    return false;
  }

  return /active LinkDish Family household|active household|households are not enabled/i.test(
    getApiErrorMessage(err)
  );
};

export const isSharedRecipeNotFoundError = (err: unknown): boolean =>
  isExtractorApiError(err) && err.statusCode === 404;

export interface SharedRecipesState {
  recipes: SharedRecipe[];
  status: "idle" | "loading" | "ready" | "error";
  /** Friendly message when the list could not be loaded or Family is not available. */
  error: string | null;
  /** Signed in, but there is no active Family household. */
  accessBlocked: boolean;
  reload: () => Promise<void>;
  /** Drops a recipe from the list without refetching (after unsharing). */
  removeLocal: (id: string) => void;
}

/** Remembers the last list per account so returning to the Cookbook shows it instantly. */
let cache: { userId: string; recipes: SharedRecipe[] } | null = null;
/** One request at a time per account, however many screens ask. */
let inflight: { userId: string | undefined; promise: Promise<SharedRecipe[]> } | null = null;

const fetchSharedRecipes = (userId: string | undefined): Promise<SharedRecipe[]> => {
  if (inflight && inflight.userId === userId) {
    return inflight.promise;
  }

  const promise = apiClient
    .getSharedRecipes()
    .then((response) => response.recipes)
    .finally(() => {
      if (inflight?.promise === promise) {
        inflight = null;
      }
    });
  inflight = { promise, userId };
  return promise;
};

export const resetSharedRecipesCacheForTests = (): void => {
  cache = null;
  inflight = null;
};

/**
 * The Family cookbook for a signed-in account, loaded when the Cookbook opens (so the Family tab
 * knows whether it is locked) and cached for the rest of the session.
 */
export function useSharedRecipes(
  isAuthenticated: boolean,
  userId: string | undefined
): SharedRecipesState {
  const cached = isAuthenticated && userId && cache?.userId === userId ? cache.recipes : null;
  const [recipes, setRecipes] = useState<SharedRecipe[]>(cached ?? []);
  const [status, setStatus] = useState<SharedRecipesState["status"]>(
    cached ? "ready" : isAuthenticated ? "loading" : "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const [accessBlocked, setAccessBlocked] = useState(false);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;

    if (!isAuthenticated) {
      setRecipes([]);
      setStatus("idle");
      setError(null);
      setAccessBlocked(false);
      return;
    }

    try {
      const list = await fetchSharedRecipes(userId);

      if (request !== requestRef.current) {
        return;
      }

      if (userId) {
        cache = { recipes: list, userId };
      }

      setRecipes(list);
      setStatus("ready");
      setError(null);
      setAccessBlocked(false);
    } catch (err) {
      if (request !== requestRef.current) {
        return;
      }

      const blocked = isSharedRecipeAccessError(err);

      // No household is an ordinary state (the tab shows a lock), not an error.
      if (!blocked) {
        console.error("Failed to load shared recipes:", err);
      }

      setRecipes([]);
      setStatus("error");
      setAccessBlocked(blocked);
      setError(blocked ? FAMILY_ACCESS_MESSAGE : FAMILY_LOAD_ERROR_MESSAGE);
    }
  }, [isAuthenticated, userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const removeLocal = useCallback((id: string) => {
    setRecipes((current) => {
      const next = current.filter((recipe) => recipe.id !== id);

      if (cache) {
        cache = { ...cache, recipes: next };
      }

      return next;
    });
  }, []);

  return { accessBlocked, error, recipes, reload, removeLocal, status };
}
