import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";
import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren
} from "react";

import { trackMobileEvent } from "../../analytics/client";
import { mobileEnv } from "../../config/env";
import { useAccount } from "../account/AccountContext";
import { useBilling } from "../billing/BillingContext";
import { billingPlans } from "../billing/plans";
import { canSaveAnotherRecipe } from "../billing/store";

import {
  cloneSavedRecipeRecord,
  createSavedRecipeRecord,
  getQuotaSavedRecipeCount,
  getSavedRecipeRecordById,
  getSavedRecipeRecordBySourceUrl,
  incrementSavedRecipeTimesCooked,
  markSavedRecipeShared,
  markSavedRecipeUnshared,
  parseSavedRecipeRecords,
  removeSavedRecipeRecord,
  serializeSavedRecipeRecords,
  savedRecipeRecordToSharedRecipeRequest,
  sharedRecipeToSavedRecipeRecord,
  starterRecipeSeedRecordToSavedRecipeRecord,
  successStateToSharedRecipeRequest,
  updateSavedRecipeRecord,
  upsertSavedRecipeRecord,
  type RecipeBookShareMode,
  type SavedRecipeRecord,
  type SavedRecipeUpdate
} from "./store";

import type { SuccessfulExtractionState } from "../recipe-results/types";
import type { HouseholdDetails, SharedRecipe } from "@linkdish/api-contracts";

interface SavedRecipesContextValue {
  cloneRecipe: (id: string) => SaveRecipeResult & { recipeId?: string };
  cloneSharedRecipe: (id: string) => SaveRecipeResult & { recipeId?: string };
  canUseSharedRecipeBook: boolean;
  deleteSharedRecipe: (id: string) => Promise<SaveRecipeResult>;
  getSaveLimitStatus: (options?: { isExistingRecord?: boolean }) => SaveLimitStatus;
  getSavedRecipeById: (id: string) => SavedRecipeRecord | undefined;
  getSavedRecipeBySourceUrl: (sourceUrl: string) => SavedRecipeRecord | undefined;
  getSharedRecipeById: (id: string) => SharedRecipe | undefined;
  hasLoadedSavedRecipes: boolean;
  hasLoadedSharedRecipes: boolean;
  incrementRecipeTimesCooked: (id: string) => boolean;
  refreshSharedRecipes: () => Promise<void>;
  removeRecipe: (id: string) => void;
  saveRecipe: (
    state: SuccessfulExtractionState
  ) => Promise<SaveRecipeResult & { recipeId?: string }>;
  saveRecipeToTargets: (
    state: SuccessfulExtractionState,
    target: "personal" | "family" | "both"
  ) => Promise<SaveRecipeResult & { recipeId?: string; sharedRecipeId?: string }>;
  savedRecipes: SavedRecipeRecord[];
  setShareMode: (mode: RecipeBookShareMode) => Promise<void>;
  shareAllPersonalRecipes: () => Promise<SaveRecipeResult>;
  sharedRecipeError: string | null;
  sharedRecipes: SharedRecipe[];
  shareMode: RecipeBookShareMode;
  shareRecipe: (id: string) => Promise<SaveRecipeResult & { sharedRecipeId?: string }>;
  unshareRecipe: (id: string) => Promise<SaveRecipeResult>;
  updateRecipe: (id: string, update: SavedRecipeUpdate) => boolean;
  updateSharedRecipe: (id: string, update: SavedRecipeUpdate) => Promise<boolean>;
}

const SavedRecipesContext = createContext<SavedRecipesContextValue | null>(null);
const SAVED_RECIPES_STORAGE_KEY = "linkdish.savedRecipes";
const STARTER_RECIPES_SEEDED_STORAGE_KEY = "linkdish.starterRecipesSeeded.v1";
const RECIPE_BOOK_SHARE_MODE_STORAGE_KEY_PREFIX = "linkdish.recipeBookShareMode";

const getRecipeBookShareModeStorageKey = (
  userId: string,
  householdId: HouseholdDetails["id"]
): string => `${RECIPE_BOOK_SHARE_MODE_STORAGE_KEY_PREFIX}:${userId}:${householdId}`;

const parseRecipeBookShareMode = (value: string | null): RecipeBookShareMode =>
  value === "selected" || value === "all" || value === "none" ? value : "none";

const buildPartialShareMessage = (message?: string): string =>
  message
    ? `Saved to your personal book, but Family sharing failed: ${message}`
    : "Saved to your personal book, but Family sharing failed.";

export interface SaveLimitStatus {
  allowed: boolean;
  message?: string;
}

export interface SaveRecipeResult extends SaveLimitStatus {
  saved: boolean;
}

const getSharedRecipeErrorMessage = (error: unknown): string => {
  if (error instanceof ExtractorApiError && typeof error.details === "object" && error.details) {
    const message = (error.details as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return error instanceof Error ? error.message : "Family recipe book action failed.";
};

export const SavedRecipesProvider = ({ children }: PropsWithChildren) => {
  const { getAuthHeaders, isSignedIn, user } = useAccount();
  const { tier } = useBilling();
  const [hasLoadedSavedRecipes, setHasLoadedSavedRecipes] = useState(false);
  const [hasLoadedSharedRecipes, setHasLoadedSharedRecipes] = useState(false);
  const [savedRecipes, setSavedRecipes] = useState<SavedRecipeRecord[]>([]);
  const [sharedRecipes, setSharedRecipes] = useState<SharedRecipe[]>([]);
  const [sharedRecipeError, setSharedRecipeError] = useState<string | null>(null);
  const [shareMode, setShareModeState] = useState<RecipeBookShareMode>("none");
  const [activeHouseholdId, setActiveHouseholdId] = useState<HouseholdDetails["id"] | null>(null);
  const [hasLoadedShareMode, setHasLoadedShareMode] = useState(false);
  const client = useMemo(
    () =>
      createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        getHeaders: getAuthHeaders
      }),
    [getAuthHeaders]
  );
  const shareModeStorageKey = useMemo(
    () =>
      user && activeHouseholdId
        ? getRecipeBookShareModeStorageKey(user.id, activeHouseholdId)
        : null,
    [activeHouseholdId, user]
  );
  const canUseSharedRecipeBook =
    isSignedIn &&
    user != null &&
    activeHouseholdId != null &&
    hasLoadedSharedRecipes &&
    sharedRecipeError == null;

  const getSaveLimitStatus = (options?: { isExistingRecord?: boolean }): SaveLimitStatus => {
    if (canUseSharedRecipeBook) {
      return { allowed: true };
    }

    const allowed = canSaveAnotherRecipe(
      tier,
      getQuotaSavedRecipeCount(savedRecipes),
      options?.isExistingRecord ?? false
    );

    if (allowed) {
      return { allowed: true };
    }

    return {
      allowed: false,
      message: `Your free Cookbook holds up to ${billingPlans.free.limits.savedRecipes} personal recipes. Upgrade for unlimited saves.`
    };
  };

  const refreshSharedRecipes = useCallback(async () => {
    if (!isSignedIn || !user) {
      setActiveHouseholdId(null);
      setSharedRecipes([]);
      setSharedRecipeError(null);
      setHasLoadedSharedRecipes(true);
      return;
    }

    setHasLoadedSharedRecipes(false);
    let nextHouseholdId: string | null = null;

    try {
      const householdResponse = await client.getHousehold();
      nextHouseholdId = householdResponse.household?.id ?? null;
      setActiveHouseholdId(nextHouseholdId);

      if (!nextHouseholdId) {
        setSharedRecipes([]);
        setSharedRecipeError(null);
        return;
      }

      const response = await client.getSharedRecipes();
      setSharedRecipes(response.recipes);
      setSharedRecipeError(null);
    } catch (error) {
      if (!nextHouseholdId) {
        setActiveHouseholdId(null);
      }
      setSharedRecipes([]);
      setSharedRecipeError(getSharedRecipeErrorMessage(error));
    } finally {
      setHasLoadedSharedRecipes(true);
    }
  }, [client, isSignedIn, user]);

  useEffect(() => {
    let isMounted = true;

    const hydrateSavedRecipes = async () => {
      try {
        const [storedRecipes, storedSeeded] = await Promise.all([
          AsyncStorage.getItem(SAVED_RECIPES_STORAGE_KEY),
          AsyncStorage.getItem(STARTER_RECIPES_SEEDED_STORAGE_KEY)
        ]);

        if (!isMounted) {
          return;
        }

        const loadedRecipes = parseSavedRecipeRecords(storedRecipes);
        const shouldSeedStarterRecipes = loadedRecipes.length === 0 && storedSeeded !== "true";
        const hydratedRecipes = shouldSeedStarterRecipes
          ? createStarterRecipeSeedRecords().map(starterRecipeSeedRecordToSavedRecipeRecord)
          : loadedRecipes;
        if (storedSeeded !== "true") {
          await AsyncStorage.setItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");
        }
        setSavedRecipes((current) =>
          current.reduce(
            (accumulator, entry) => upsertSavedRecipeRecord(accumulator, entry),
            hydratedRecipes
          )
        );
      } catch (error) {
        console.warn("Failed to load saved recipes.", error);
      } finally {
        if (isMounted) {
          setHasLoadedSavedRecipes(true);
        }
      }
    };

    void hydrateSavedRecipes();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const hydrateShareMode = async () => {
      if (!shareModeStorageKey) {
        setShareModeState("none");
        setHasLoadedShareMode(true);
        return;
      }

      setHasLoadedShareMode(false);
      setShareModeState("none");

      try {
        const storedMode = await AsyncStorage.getItem(shareModeStorageKey);
        await AsyncStorage.removeItem(RECIPE_BOOK_SHARE_MODE_STORAGE_KEY_PREFIX);

        if (!isMounted) {
          return;
        }

        setShareModeState(parseRecipeBookShareMode(storedMode));
      } catch (error) {
        console.warn("Failed to load recipe book sharing mode.", error);
      } finally {
        if (isMounted) {
          setHasLoadedShareMode(true);
        }
      }
    };

    void hydrateShareMode();

    return () => {
      isMounted = false;
    };
  }, [shareModeStorageKey]);

  useEffect(() => {
    void refreshSharedRecipes();
  }, [refreshSharedRecipes]);

  useEffect(() => {
    if (!hasLoadedSavedRecipes) {
      return;
    }

    const persistSavedRecipes = async () => {
      try {
        await AsyncStorage.setItem(
          SAVED_RECIPES_STORAGE_KEY,
          serializeSavedRecipeRecords(savedRecipes)
        );
      } catch (error) {
        console.warn("Failed to persist saved recipes.", error);
      }
    };

    void persistSavedRecipes();
  }, [hasLoadedSavedRecipes, savedRecipes]);

  useEffect(() => {
    if (!shareModeStorageKey || !hasLoadedShareMode) {
      return;
    }

    const persistShareMode = async () => {
      try {
        await AsyncStorage.setItem(shareModeStorageKey, shareMode);
      } catch (error) {
        console.warn("Failed to persist recipe book sharing mode.", error);
      }
    };

    void persistShareMode();
  }, [hasLoadedShareMode, shareMode, shareModeStorageKey]);

  const upsertSharedRecipe = (recipe: SharedRecipe) => {
    setSharedRecipes((current) => [recipe, ...current.filter((entry) => entry.id !== recipe.id)]);
  };

  const removeSharedRecipeFromState = (sharedRecipeId: string) => {
    setSharedRecipes((current) => current.filter((entry) => entry.id !== sharedRecipeId));
    setSavedRecipes((current) =>
      current.map((entry) =>
        entry.sharedRecipeId === sharedRecipeId
          ? {
              ...entry,
              sharedAt: undefined,
              sharedRecipeId: undefined
            }
          : entry
      )
    );
  };

  const shareRecipeRecord = async (
    record: SavedRecipeRecord
  ): Promise<SaveRecipeResult & { sharedRecipeId?: string }> => {
    if (record.isStarter) {
      return {
        allowed: true,
        message: "Starter recipes stay local to your Cookbook.",
        saved: false
      };
    }

    if (!isSignedIn) {
      return {
        allowed: false,
        message: "Sign in to share recipes with your household.",
        saved: false
      };
    }

    try {
      if (record.sharedRecipeId) {
        const response = await client.updateSharedRecipe(record.sharedRecipeId, {
          fetchMode: record.fetchMode,
          notes: record.notes ?? null,
          provenance: record.provenance as Parameters<
            typeof client.updateSharedRecipe
          >[1]["provenance"],
          recipe: record.recipe,
          strategy: record.strategy as Parameters<typeof client.updateSharedRecipe>[1]["strategy"],
          warnings: record.warnings
        });
        upsertSharedRecipe(response.recipe);
        setSavedRecipes((current) => markSavedRecipeShared(current, record.id, response.recipe));
        setSharedRecipeError(null);

        return {
          allowed: true,
          saved: true,
          sharedRecipeId: response.recipe.id
        };
      }

      const response = await client.createSharedRecipe(
        savedRecipeRecordToSharedRecipeRequest(record)
      );
      upsertSharedRecipe(response.recipe);
      setSavedRecipes((current) => markSavedRecipeShared(current, record.id, response.recipe));
      setSharedRecipeError(null);

      trackMobileEvent({
        eventName: "family_shared",
        routeOrScreen: "recipe",
        properties: {
          recipe_count: 1,
          share_scope: "household"
        }
      });

      return {
        allowed: true,
        saved: true,
        sharedRecipeId: response.recipe.id
      };
    } catch (error) {
      const message = getSharedRecipeErrorMessage(error);
      setSharedRecipeError(message);

      return {
        allowed: false,
        message,
        saved: false
      };
    }
  };

  const savePersonalRecipe = (
    state: SuccessfulExtractionState
  ): SaveRecipeResult & { recipe?: SavedRecipeRecord; recipeId?: string } => {
    const existingRecord = getSavedRecipeRecordBySourceUrl(savedRecipes, state.recipe.sourceUrl);
    const saveGate = getSaveLimitStatus({ isExistingRecord: existingRecord != null });

    if (!saveGate.allowed) {
      return {
        ...saveGate,
        saved: false
      };
    }

    const createdRecord = createSavedRecipeRecord(state);
    const nextRecord = {
      ...createdRecord,
      id: existingRecord?.id ?? createdRecord.id,
      sharedAt: existingRecord?.sharedAt,
      sharedRecipeId: existingRecord?.sharedRecipeId,
      timesCooked: existingRecord?.timesCooked ?? createdRecord.timesCooked
    };

    setSavedRecipes((current) => upsertSavedRecipeRecord(current, nextRecord));

    trackMobileEvent({
      eventName: "recipe_saved",
      routeOrScreen: "recipe",
      properties: {
        source_type: state.sourceImages?.length ? "image" : "url",
        surface: "import_result"
      }
    });

    return {
      allowed: true,
      recipe: nextRecord,
      recipeId: nextRecord.id,
      saved: true
    };
  };

  const shareAllPersonalRecipes = async (): Promise<SaveRecipeResult> => {
    for (const recipe of savedRecipes.filter((entry) => !entry.isStarter)) {
      const result = await shareRecipeRecord(recipe);

      if (!result.saved) {
        return result;
      }
    }

    return {
      allowed: true,
      saved: true
    };
  };

  const unshareAllOwnedRecipes = async (): Promise<SaveRecipeResult> => {
    if (!isSignedIn) {
      return {
        allowed: true,
        saved: true
      };
    }

    const ownedSharedRecipeIds = sharedRecipes
      .filter((recipe) => recipe.ownerUserId === user?.id)
      .map((recipe) => recipe.id);

    try {
      for (const sharedRecipeId of ownedSharedRecipeIds) {
        await client.deleteSharedRecipe(sharedRecipeId);
      }

      setSharedRecipes((current) => current.filter((recipe) => recipe.ownerUserId !== user?.id));
      setSavedRecipes((current) =>
        current.map((entry) => ({
          ...entry,
          sharedAt: undefined,
          sharedRecipeId: undefined
        }))
      );
      setSharedRecipeError(null);

      return {
        allowed: true,
        saved: true
      };
    } catch (error) {
      const message = getSharedRecipeErrorMessage(error);
      setSharedRecipeError(message);

      return {
        allowed: false,
        message,
        saved: false
      };
    }
  };

  const syncSharedRecipeFromRecord = async (record: SavedRecipeRecord): Promise<void> => {
    if (!record.sharedRecipeId || !isSignedIn) {
      return;
    }

    try {
      const response = await client.updateSharedRecipe(record.sharedRecipeId, {
        fetchMode: record.fetchMode,
        notes: record.notes ?? null,
        provenance: record.provenance as Parameters<
          typeof client.updateSharedRecipe
        >[1]["provenance"],
        recipe: record.recipe,
        strategy: record.strategy as Parameters<typeof client.updateSharedRecipe>[1]["strategy"],
        warnings: record.warnings
      });
      upsertSharedRecipe(response.recipe);
      setSavedRecipes((current) => markSavedRecipeShared(current, record.id, response.recipe));
      setSharedRecipeError(null);
    } catch (error) {
      setSharedRecipeError(getSharedRecipeErrorMessage(error));
    }
  };

  return (
    <SavedRecipesContext.Provider
      value={{
        cloneRecipe: (id) => {
          const sourceRecord = getSavedRecipeRecordById(savedRecipes, id);

          if (!sourceRecord) {
            return {
              allowed: false,
              message: "This saved recipe is no longer available.",
              saved: false
            };
          }

          const saveGate = getSaveLimitStatus();

          if (!saveGate.allowed) {
            return {
              ...saveGate,
              saved: false
            };
          }

          const clonedRecipe = cloneSavedRecipeRecord(savedRecipes, sourceRecord);
          setSavedRecipes((current) => [clonedRecipe, ...current]);

          return {
            allowed: true,
            recipeId: clonedRecipe.id,
            saved: true
          };
        },
        cloneSharedRecipe: (id) => {
          const sourceRecord = sharedRecipes.find((entry) => entry.id === id);

          if (!sourceRecord) {
            return {
              allowed: false,
              message: "This shared recipe is no longer available.",
              saved: false
            };
          }

          const saveGate = getSaveLimitStatus();

          if (!saveGate.allowed) {
            return {
              ...saveGate,
              saved: false
            };
          }

          const sourceSavedRecord = sharedRecipeToSavedRecipeRecord(sourceRecord);
          const clonedRecipe = cloneSavedRecipeRecord(savedRecipes, sourceSavedRecord);
          setSavedRecipes((current) => [clonedRecipe, ...current]);

          return {
            allowed: true,
            recipeId: clonedRecipe.id,
            saved: true
          };
        },
        canUseSharedRecipeBook,
        deleteSharedRecipe: async (id) => {
          try {
            await client.deleteSharedRecipe(id);
            removeSharedRecipeFromState(id);
            setSharedRecipeError(null);

            return {
              allowed: true,
              saved: true
            };
          } catch (error) {
            const message = getSharedRecipeErrorMessage(error);
            setSharedRecipeError(message);

            return {
              allowed: false,
              message,
              saved: false
            };
          }
        },
        getSaveLimitStatus,
        getSavedRecipeById: (id) => getSavedRecipeRecordById(savedRecipes, id),
        getSavedRecipeBySourceUrl: (sourceUrl) =>
          getSavedRecipeRecordBySourceUrl(savedRecipes, sourceUrl),
        getSharedRecipeById: (id) => sharedRecipes.find((entry) => entry.id === id),
        hasLoadedSavedRecipes,
        hasLoadedSharedRecipes,
        incrementRecipeTimesCooked: (id) => {
          const sourceRecord = getSavedRecipeRecordById(savedRecipes, id);

          if (!sourceRecord) {
            return false;
          }

          setSavedRecipes((current) => incrementSavedRecipeTimesCooked(current, id));
          return true;
        },
        refreshSharedRecipes,
        removeRecipe: (id) => {
          setSavedRecipes((current) => removeSavedRecipeRecord(current, id));
        },
        saveRecipe: async (state) => {
          const result = savePersonalRecipe(state);

          if (result.saved && result.recipe && shareMode === "all") {
            const sharedResult = await shareRecipeRecord(result.recipe);

            if (!sharedResult.saved) {
              return {
                allowed: true,
                message: buildPartialShareMessage(sharedResult.message),
                ...(result.recipeId ? { recipeId: result.recipeId } : {}),
                saved: true
              };
            }
          }

          return {
            allowed: result.allowed,
            ...(result.message ? { message: result.message } : {}),
            ...(result.recipeId ? { recipeId: result.recipeId } : {}),
            saved: result.saved
          };
        },
        saveRecipeToTargets: async (state, target) => {
          if (target === "family") {
            try {
              const response = await client.createSharedRecipe(
                successStateToSharedRecipeRequest(state)
              );
              upsertSharedRecipe(response.recipe);
              setSharedRecipeError(null);

              trackMobileEvent({
                eventName: "family_shared",
                routeOrScreen: "recipe",
                properties: {
                  recipe_count: 1,
                  share_scope: "household"
                }
              });

              return {
                allowed: true,
                saved: true,
                sharedRecipeId: response.recipe.id
              };
            } catch (error) {
              const message = getSharedRecipeErrorMessage(error);
              setSharedRecipeError(message);

              return {
                allowed: false,
                message,
                saved: false
              };
            }
          }

          const personalResult = savePersonalRecipe(state);

          if (!personalResult.saved || !personalResult.recipe) {
            return {
              allowed: personalResult.allowed,
              ...(personalResult.message ? { message: personalResult.message } : {}),
              ...(personalResult.recipeId ? { recipeId: personalResult.recipeId } : {}),
              saved: false
            };
          }

          if (target === "both") {
            const sharedResult = await shareRecipeRecord(personalResult.recipe);

            if (!sharedResult.saved) {
              return {
                allowed: true,
                message: buildPartialShareMessage(sharedResult.message),
                ...(personalResult.recipeId ? { recipeId: personalResult.recipeId } : {}),
                saved: true
              };
            }

            return {
              allowed: sharedResult.allowed,
              ...(sharedResult.message ? { message: sharedResult.message } : {}),
              ...(personalResult.recipeId ? { recipeId: personalResult.recipeId } : {}),
              saved: sharedResult.saved,
              ...(sharedResult.sharedRecipeId
                ? { sharedRecipeId: sharedResult.sharedRecipeId }
                : {})
            };
          }

          if (shareMode === "all") {
            const sharedResult = await shareRecipeRecord(personalResult.recipe);

            if (!sharedResult.saved) {
              return {
                allowed: true,
                message: buildPartialShareMessage(sharedResult.message),
                ...(personalResult.recipeId ? { recipeId: personalResult.recipeId } : {}),
                saved: true
              };
            }
          }

          return {
            allowed: true,
            ...(personalResult.recipeId ? { recipeId: personalResult.recipeId } : {}),
            saved: true
          };
        },
        savedRecipes,
        setShareMode: async (mode) => {
          if (mode === "all") {
            const result = await shareAllPersonalRecipes();

            if (!result.saved) {
              return;
            }
          }

          if (mode === "none") {
            const result = await unshareAllOwnedRecipes();

            if (!result.saved) {
              return;
            }
          }

          setShareModeState(mode);
        },
        shareAllPersonalRecipes,
        sharedRecipeError,
        sharedRecipes,
        shareMode,
        shareRecipe: async (id) => {
          const sourceRecord = getSavedRecipeRecordById(savedRecipes, id);

          if (!sourceRecord) {
            return {
              allowed: false,
              message: "This saved recipe is no longer available.",
              saved: false
            };
          }

          return shareRecipeRecord(sourceRecord);
        },
        unshareRecipe: async (id) => {
          const sourceRecord = getSavedRecipeRecordById(savedRecipes, id);

          if (!sourceRecord?.sharedRecipeId) {
            setSavedRecipes((current) => markSavedRecipeUnshared(current, id));
            return {
              allowed: true,
              saved: true
            };
          }

          try {
            await client.deleteSharedRecipe(sourceRecord.sharedRecipeId);
            removeSharedRecipeFromState(sourceRecord.sharedRecipeId);
            setSavedRecipes((current) => markSavedRecipeUnshared(current, id));
            setSharedRecipeError(null);

            return {
              allowed: true,
              saved: true
            };
          } catch (error) {
            const message = getSharedRecipeErrorMessage(error);
            setSharedRecipeError(message);

            return {
              allowed: false,
              message,
              saved: false
            };
          }
        },
        updateRecipe: (id, update) => {
          const sourceRecord = getSavedRecipeRecordById(savedRecipes, id);

          if (sourceRecord) {
            const nextRecord = {
              ...sourceRecord,
              notes: update.notes,
              recipe: update.recipe ?? sourceRecord.recipe,
              updatedAt: update.updatedAt ?? new Date().toISOString()
            };
            setSavedRecipes((current) => updateSavedRecipeRecord(current, id, update));

            if (nextRecord.sharedRecipeId) {
              void syncSharedRecipeFromRecord(nextRecord);
            }
          }

          return sourceRecord != null;
        },
        updateSharedRecipe: async (id, update) => {
          const sourceRecord = sharedRecipes.find((entry) => entry.id === id);

          if (!sourceRecord) {
            return false;
          }

          try {
            const payload: Parameters<typeof client.updateSharedRecipe>[1] = {
              recipe: update.recipe,
              warnings: sourceRecord.warnings
            };

            if ("notes" in update) {
              payload.notes = update.notes ?? null;
            }

            const response = await client.updateSharedRecipe(id, payload);
            upsertSharedRecipe(response.recipe);
            setSharedRecipeError(null);
            return true;
          } catch (error) {
            setSharedRecipeError(getSharedRecipeErrorMessage(error));
            return false;
          }
        }
      }}
    >
      {children}
    </SavedRecipesContext.Provider>
  );
};

export const useSavedRecipes = () => {
  const context = useContext(SavedRecipesContext);

  if (!context) {
    throw new Error("useSavedRecipes must be used within SavedRecipesProvider.");
  }

  return context;
};
