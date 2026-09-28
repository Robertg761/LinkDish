import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";
import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { AppState } from "react-native";

import { trackMobileEvent } from "../../analytics/client";
import { mobileEnv } from "../../config/env";
import { createDebouncedWriter } from "../../lib/debouncedWriter";
import { useAccount } from "../account/AccountContext";
import { useBilling } from "../billing/BillingContext";
import { billingPlans } from "../billing/plans";
import { canSaveAnotherRecipe } from "../billing/store";

import { deleteRecipeSourceImageFiles, persistRecipeSourceImages } from "./sourceImageFiles";
import {
  cloneSavedRecipeRecord,
  createSavedRecipeRecord,
  getOrphanedSourceImageUris,
  getQuotaSavedRecipeCount,
  getSavedRecipeRecordById,
  getSavedRecipeRecordBySourceUrl,
  incrementSavedRecipeTimesCooked,
  isDataUrlSourceImage,
  markSavedRecipeShared,
  markSavedRecipeUnshared,
  readSavedRecipeRecords,
  removeSavedRecipeRecord,
  serializeSavedRecipeRecords,
  savedRecipeRecordToSharedRecipeRequest,
  setSavedRecipeFavorite,
  sharedRecipeToSavedRecipeRecord,
  starterRecipeSeedRecordToSavedRecipeRecord,
  successStateToSharedRecipeRequest,
  updateSavedRecipeRecord,
  upsertSavedRecipeRecord,
  type RecipeBookShareMode,
  type SavedRecipeRecord,
  type SavedRecipeUpdate
} from "./store";

import type { BillingTier } from "../billing/plans";
import type { SuccessfulExtractionState } from "../recipe-results/types";
import type { HouseholdDetails, SharedRecipe } from "@linkdish/api-contracts";

export interface SavedRecipesState {
  canUseSharedRecipeBook: boolean;
  getSaveLimitStatus: (options?: { isExistingRecord?: boolean }) => SaveLimitStatus;
  getSavedRecipeById: (id: string) => SavedRecipeRecord | undefined;
  getSavedRecipeBySourceUrl: (sourceUrl: string) => SavedRecipeRecord | undefined;
  getSharedRecipeById: (id: string) => SharedRecipe | undefined;
  hasLoadedSavedRecipes: boolean;
  hasLoadedSharedRecipes: boolean;
  savedRecipes: SavedRecipeRecord[];
  sharedRecipeError: string | null;
  sharedRecipes: SharedRecipe[];
  shareMode: RecipeBookShareMode;
}

export interface SavedRecipesActions {
  cloneRecipe: (id: string) => SaveRecipeResult & { recipeId?: string };
  cloneSharedRecipe: (id: string) => SaveRecipeResult & { recipeId?: string };
  deleteSharedRecipe: (id: string) => Promise<SaveRecipeResult>;
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
  /** Hearts or un-hearts a personal recipe. Returns false when the recipe is gone. */
  setRecipeFavorite: (id: string, favorite: boolean) => boolean;
  setShareMode: (mode: RecipeBookShareMode) => Promise<void>;
  shareAllPersonalRecipes: () => Promise<SaveRecipeResult>;
  shareRecipe: (id: string) => Promise<SaveRecipeResult & { sharedRecipeId?: string }>;
  unshareRecipe: (id: string) => Promise<SaveRecipeResult>;
  updateRecipe: (id: string, update: SavedRecipeUpdate) => boolean;
  updateSharedRecipe: (id: string, update: SavedRecipeUpdate) => Promise<boolean>;
}

export type SavedRecipesContextValue = SavedRecipesState & SavedRecipesActions;

const SavedRecipesStateContext = createContext<SavedRecipesState | null>(null);
const SavedRecipesActionsContext = createContext<SavedRecipesActions | null>(null);
const SAVED_RECIPES_STORAGE_KEY = "linkdish.savedRecipes";
const SAVED_RECIPES_CORRUPT_BACKUP_STORAGE_KEY = "linkdish.savedRecipes.corrupt.v1";
const STARTER_RECIPES_SEEDED_STORAGE_KEY = "linkdish.starterRecipesSeeded.v1";
const RECIPE_BOOK_SHARE_MODE_STORAGE_KEY_PREFIX = "linkdish.recipeBookShareMode";
/**
 * Small edits (times cooked, a heart, a share flag) are written once they settle instead of
 * re-serializing the whole cookbook on every tap; the write is flushed when the app backgrounds.
 */
export const SAVED_RECIPES_PERSIST_DEBOUNCE_MS = 400;

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

export type SaveRecipeFailureReason = "persist_failed" | "save_limit_reached";

export interface SaveLimitStatus {
  allowed: boolean;
  message?: string;
  reason?: SaveRecipeFailureReason;
}

export interface SaveRecipeResult extends SaveLimitStatus {
  saved: boolean;
}

const computeSaveLimitStatus = (
  input: {
    canUseSharedRecipeBook: boolean;
    savedRecipes: SavedRecipeRecord[];
    tier: BillingTier;
  },
  options?: { isExistingRecord?: boolean }
): SaveLimitStatus => {
  if (input.canUseSharedRecipeBook) {
    return { allowed: true };
  }

  const allowed = canSaveAnotherRecipe(
    input.tier,
    getQuotaSavedRecipeCount(input.savedRecipes),
    options?.isExistingRecord ?? false
  );

  if (allowed) {
    return { allowed: true };
  }

  return {
    allowed: false,
    message: `Your free Cookbook holds up to ${billingPlans.free.limits.savedRecipes} personal recipes. Upgrade for unlimited saves.`,
    reason: "save_limit_reached"
  };
};

/**
 * Rewrites any scan photo that is still inlined as base64 onto the filesystem.
 *
 * Cookbooks written by older builds stored the full `data:` URL in the record,
 * which is what used to make the cookbook too large for AsyncStorage to persist.
 */
const migrateLegacySourceImages = (
  records: SavedRecipeRecord[]
): { didMigrate: boolean; records: SavedRecipeRecord[] } => {
  if (!records.some((record) => record.sourceImages?.some(isDataUrlSourceImage))) {
    return { didMigrate: false, records };
  }

  const migratedRecords = records.map((record) => {
    if (!record.sourceImages?.some(isDataUrlSourceImage)) {
      return record;
    }

    return {
      ...record,
      sourceImages: persistRecipeSourceImages(record.id, record.sourceImages)
    };
  });

  return { didMigrate: true, records: migratedRecords };
};

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
  const [hasUnreadableStoredRecipes, setHasUnreadableStoredRecipes] = useState(false);
  const [sharedRecipes, setSharedRecipes] = useState<SharedRecipe[]>([]);
  const [sharedRecipeError, setSharedRecipeError] = useState<string | null>(null);
  const [shareMode, setShareModeState] = useState<RecipeBookShareMode>("none");
  const [activeHouseholdId, setActiveHouseholdId] = useState<HouseholdDetails["id"] | null>(null);
  const [hasLoadedShareMode, setHasLoadedShareMode] = useState(false);
  const savedRecipesRef = useRef<SavedRecipeRecord[]>([]);
  const lastWrittenCookbookRef = useRef<string | null>(null);
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
  // Actions read the latest render's values through this ref, so their identities stay stable
  // and the context value only changes when the cookbook itself does.
  const latestRef = useRef({
    canUseSharedRecipeBook,
    client,
    isSignedIn,
    sharedRecipes,
    shareMode,
    tier,
    userId: user?.id
  });
  latestRef.current = {
    canUseSharedRecipeBook,
    client,
    isSignedIn,
    sharedRecipes,
    shareMode,
    tier,
    userId: user?.id
  };

  /** Every cookbook change goes through here; the ref is always the latest list. */
  const commitSavedRecipes = useCallback(
    (update: (records: SavedRecipeRecord[]) => SavedRecipeRecord[]) => {
      savedRecipesRef.current = update(savedRecipesRef.current);
      setSavedRecipes(savedRecipesRef.current);
    },
    []
  );

  const writer = useMemo(
    () =>
      createDebouncedWriter<SavedRecipeRecord[]>(
        async (records) => {
          const serialized = serializeSavedRecipeRecords(records);

          // An explicit save already wrote this exact cookbook; skip the redundant write.
          if (serialized === lastWrittenCookbookRef.current) {
            return;
          }

          await AsyncStorage.setItem(SAVED_RECIPES_STORAGE_KEY, serialized);
          lastWrittenCookbookRef.current = serialized;
        },
        SAVED_RECIPES_PERSIST_DEBOUNCE_MS,
        (error) => {
          console.warn("Failed to persist saved recipes.", error);
        }
      ),
    []
  );

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

        const { records: loadedRecipes, status } = readSavedRecipeRecords(storedRecipes);

        if (status === "corrupt") {
          console.warn("Saved recipes could not be read. Keeping the stored copy for recovery.");
          setHasUnreadableStoredRecipes(true);

          try {
            await AsyncStorage.setItem(
              SAVED_RECIPES_CORRUPT_BACKUP_STORAGE_KEY,
              storedRecipes ?? ""
            );
          } catch (error) {
            console.warn("Failed to back up the unreadable saved recipes.", error);
          }
        }

        const { didMigrate, records: migratedRecipes } = migrateLegacySourceImages(loadedRecipes);
        const shouldSeedStarterRecipes =
          status !== "corrupt" && migratedRecipes.length === 0 && storedSeeded !== "true";
        const hydratedRecipes = shouldSeedStarterRecipes
          ? createStarterRecipeSeedRecords().map(starterRecipeSeedRecordToSavedRecipeRecord)
          : migratedRecipes;

        if (status !== "corrupt" && storedSeeded !== "true") {
          await AsyncStorage.setItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");
        }

        if (!isMounted) {
          return;
        }

        // What was just read needs no write-back; a migration or seeding does.
        if (status === "ok" && !didMigrate && !shouldSeedStarterRecipes) {
          lastWrittenCookbookRef.current = serializeSavedRecipeRecords(hydratedRecipes);
        }

        commitSavedRecipes((current) =>
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
  }, [commitSavedRecipes]);

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

    // The stored cookbook could not be parsed. Writing an empty list over it now
    // would turn a recoverable read failure into permanent data loss, so wait
    // until there is something real to store.
    if (hasUnreadableStoredRecipes && savedRecipes.length === 0) {
      return;
    }

    writer.schedule(savedRecipes);
  }, [hasLoadedSavedRecipes, hasUnreadableStoredRecipes, savedRecipes, writer]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        void writer.flush().catch((error: unknown) => {
          console.warn("Failed to persist saved recipes.", error);
        });
      }
    });

    return () => {
      subscription.remove();
      void writer.flush().catch(() => undefined);
    };
  }, [writer]);

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

  const getLatestSaveLimitStatus = useCallback(
    (options?: { isExistingRecord?: boolean }): SaveLimitStatus =>
      computeSaveLimitStatus(
        {
          canUseSharedRecipeBook: latestRef.current.canUseSharedRecipeBook,
          savedRecipes: savedRecipesRef.current,
          tier: latestRef.current.tier
        },
        options
      ),
    []
  );

  const upsertSharedRecipe = useCallback((recipe: SharedRecipe) => {
    setSharedRecipes((current) => [recipe, ...current.filter((entry) => entry.id !== recipe.id)]);
  }, []);

  const removeSharedRecipeFromState = useCallback(
    (sharedRecipeId: string) => {
      setSharedRecipes((current) => current.filter((entry) => entry.id !== sharedRecipeId));
      commitSavedRecipes((current) =>
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
    },
    [commitSavedRecipes]
  );

  const shareRecipeRecord = useCallback(
    async (record: SavedRecipeRecord): Promise<SaveRecipeResult & { sharedRecipeId?: string }> => {
      const { client: apiClient, isSignedIn: signedIn } = latestRef.current;

      if (record.isStarter) {
        return {
          allowed: true,
          message: "Starter recipes stay local to your Cookbook.",
          saved: false
        };
      }

      if (!signedIn) {
        return {
          allowed: false,
          message: "Sign in to share recipes with your household.",
          saved: false
        };
      }

      try {
        if (record.sharedRecipeId) {
          const response = await apiClient.updateSharedRecipe(record.sharedRecipeId, {
            fetchMode: record.fetchMode,
            notes: record.notes ?? null,
            provenance: record.provenance as Parameters<
              typeof apiClient.updateSharedRecipe
            >[1]["provenance"],
            recipe: record.recipe,
            strategy: record.strategy as Parameters<
              typeof apiClient.updateSharedRecipe
            >[1]["strategy"],
            warnings: record.warnings
          });
          upsertSharedRecipe(response.recipe);
          commitSavedRecipes((current) =>
            markSavedRecipeShared(current, record.id, response.recipe)
          );
          setSharedRecipeError(null);

          return {
            allowed: true,
            saved: true,
            sharedRecipeId: response.recipe.id
          };
        }

        const response = await apiClient.createSharedRecipe(
          savedRecipeRecordToSharedRecipeRequest(record)
        );
        upsertSharedRecipe(response.recipe);
        commitSavedRecipes((current) => markSavedRecipeShared(current, record.id, response.recipe));
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
    },
    [commitSavedRecipes, upsertSharedRecipe]
  );

  const savePersonalRecipe = useCallback(
    async (
      state: SuccessfulExtractionState
    ): Promise<SaveRecipeResult & { recipe?: SavedRecipeRecord; recipeId?: string }> => {
      const existingRecord = getSavedRecipeRecordBySourceUrl(
        savedRecipesRef.current,
        state.recipe.sourceUrl
      );
      const saveGate = getLatestSaveLimitStatus({ isExistingRecord: existingRecord != null });

      if (!saveGate.allowed) {
        return {
          ...saveGate,
          saved: false
        };
      }

      const createdRecord = createSavedRecipeRecord(state);
      const recordId = existingRecord?.id ?? createdRecord.id;
      const nextRecord: SavedRecipeRecord = {
        ...createdRecord,
        favorite: existingRecord?.favorite,
        id: recordId,
        sharedAt: existingRecord?.sharedAt,
        sharedRecipeId: existingRecord?.sharedRecipeId,
        sourceImages: persistRecipeSourceImages(recordId, createdRecord.sourceImages),
        timesCooked: existingRecord?.timesCooked ?? createdRecord.timesCooked
      };
      const nextRecipes = upsertSavedRecipeRecord(savedRecipesRef.current, nextRecord);

      // Persist before reporting success: a swallowed write failure used to leave
      // the recipe looking saved until the next launch, when it was simply gone.
      try {
        await writer.writeNow(nextRecipes);
      } catch (error) {
        console.warn("Failed to persist saved recipes.", error);

        return {
          allowed: true,
          message: "This recipe could not be saved to your Cookbook. Please try again.",
          reason: "persist_failed",
          saved: false
        };
      }

      setHasUnreadableStoredRecipes(false);
      commitSavedRecipes((current) => upsertSavedRecipeRecord(current, nextRecord));

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
    },
    [commitSavedRecipes, getLatestSaveLimitStatus, writer]
  );

  const shareAllPersonalRecipes = useCallback(async (): Promise<SaveRecipeResult> => {
    for (const recipe of savedRecipesRef.current.filter((entry) => !entry.isStarter)) {
      const result = await shareRecipeRecord(recipe);

      if (!result.saved) {
        return result;
      }
    }

    return {
      allowed: true,
      saved: true
    };
  }, [shareRecipeRecord]);

  const unshareAllOwnedRecipes = useCallback(async (): Promise<SaveRecipeResult> => {
    const {
      client: apiClient,
      isSignedIn: signedIn,
      sharedRecipes: currentShared,
      userId
    } = latestRef.current;

    if (!signedIn) {
      return {
        allowed: true,
        saved: true
      };
    }

    const ownedSharedRecipeIds = currentShared
      .filter((recipe) => recipe.ownerUserId === userId)
      .map((recipe) => recipe.id);

    try {
      for (const sharedRecipeId of ownedSharedRecipeIds) {
        await apiClient.deleteSharedRecipe(sharedRecipeId);
      }

      setSharedRecipes((current) => current.filter((recipe) => recipe.ownerUserId !== userId));
      commitSavedRecipes((current) =>
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
  }, [commitSavedRecipes]);

  const syncSharedRecipeFromRecord = useCallback(
    async (record: SavedRecipeRecord): Promise<void> => {
      const { client: apiClient, isSignedIn: signedIn } = latestRef.current;

      if (!record.sharedRecipeId || !signedIn) {
        return;
      }

      try {
        const response = await apiClient.updateSharedRecipe(record.sharedRecipeId, {
          fetchMode: record.fetchMode,
          notes: record.notes ?? null,
          provenance: record.provenance as Parameters<
            typeof apiClient.updateSharedRecipe
          >[1]["provenance"],
          recipe: record.recipe,
          strategy: record.strategy as Parameters<
            typeof apiClient.updateSharedRecipe
          >[1]["strategy"],
          warnings: record.warnings
        });
        upsertSharedRecipe(response.recipe);
        commitSavedRecipes((current) => markSavedRecipeShared(current, record.id, response.recipe));
        setSharedRecipeError(null);
      } catch (error) {
        setSharedRecipeError(getSharedRecipeErrorMessage(error));
      }
    },
    [commitSavedRecipes, upsertSharedRecipe]
  );

  const cloneRecipe = useCallback(
    (id: string): SaveRecipeResult & { recipeId?: string } => {
      const sourceRecord = getSavedRecipeRecordById(savedRecipesRef.current, id);

      if (!sourceRecord) {
        return {
          allowed: false,
          message: "This saved recipe is no longer available.",
          saved: false
        };
      }

      const saveGate = getLatestSaveLimitStatus();

      if (!saveGate.allowed) {
        return {
          ...saveGate,
          saved: false
        };
      }

      const clonedRecipe = cloneSavedRecipeRecord(savedRecipesRef.current, sourceRecord);
      commitSavedRecipes((current) => [clonedRecipe, ...current]);

      return {
        allowed: true,
        recipeId: clonedRecipe.id,
        saved: true
      };
    },
    [commitSavedRecipes, getLatestSaveLimitStatus]
  );

  const cloneSharedRecipe = useCallback(
    (id: string): SaveRecipeResult & { recipeId?: string } => {
      const sourceRecord = latestRef.current.sharedRecipes.find((entry) => entry.id === id);

      if (!sourceRecord) {
        return {
          allowed: false,
          message: "This shared recipe is no longer available.",
          saved: false
        };
      }

      const saveGate = getLatestSaveLimitStatus();

      if (!saveGate.allowed) {
        return {
          ...saveGate,
          saved: false
        };
      }

      const sourceSavedRecord = sharedRecipeToSavedRecipeRecord(sourceRecord);
      const clonedRecipe = cloneSavedRecipeRecord(savedRecipesRef.current, sourceSavedRecord);
      commitSavedRecipes((current) => [clonedRecipe, ...current]);

      return {
        allowed: true,
        recipeId: clonedRecipe.id,
        saved: true
      };
    },
    [commitSavedRecipes, getLatestSaveLimitStatus]
  );

  const deleteSharedRecipe = useCallback(
    async (id: string): Promise<SaveRecipeResult> => {
      try {
        await latestRef.current.client.deleteSharedRecipe(id);
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
    [removeSharedRecipeFromState]
  );

  const incrementRecipeTimesCooked = useCallback(
    (id: string): boolean => {
      if (!getSavedRecipeRecordById(savedRecipesRef.current, id)) {
        return false;
      }

      commitSavedRecipes((current) => incrementSavedRecipeTimesCooked(current, id));
      return true;
    },
    [commitSavedRecipes]
  );

  const setRecipeFavorite = useCallback(
    (id: string, favorite: boolean): boolean => {
      if (!getSavedRecipeRecordById(savedRecipesRef.current, id)) {
        return false;
      }

      commitSavedRecipes((current) => setSavedRecipeFavorite(current, id, favorite));
      return true;
    },
    [commitSavedRecipes]
  );

  const removeRecipe = useCallback(
    (id: string) => {
      const current = savedRecipesRef.current;
      const removed = current.filter((entry) => entry.id === id);

      if (removed.length === 0) {
        return;
      }

      const remaining = removeSavedRecipeRecord(current, id);
      const orphanedScanUris = getOrphanedSourceImageUris(remaining, removed);
      commitSavedRecipes(() => remaining);

      if (orphanedScanUris.length === 0) {
        return;
      }

      // Write the removal first, so a crash can never leave a stored record pointing at scan
      // files that were already deleted. Clones share their source's files, which
      // getOrphanedSourceImageUris keeps.
      void writer
        .writeNow(remaining)
        .then(() => {
          deleteRecipeSourceImageFiles(orphanedScanUris);
        })
        .catch((error: unknown) => {
          console.warn("Failed to persist saved recipes.", error);
        });
    },
    [commitSavedRecipes, writer]
  );

  const saveRecipe = useCallback(
    async (state: SuccessfulExtractionState) => {
      const result = await savePersonalRecipe(state);

      if (result.saved && result.recipe && latestRef.current.shareMode === "all") {
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
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.recipeId ? { recipeId: result.recipeId } : {}),
        saved: result.saved
      };
    },
    [savePersonalRecipe, shareRecipeRecord]
  );

  const saveRecipeToTargets = useCallback(
    async (
      state: SuccessfulExtractionState,
      target: "personal" | "family" | "both"
    ): Promise<SaveRecipeResult & { recipeId?: string; sharedRecipeId?: string }> => {
      if (target === "family") {
        try {
          const response = await latestRef.current.client.createSharedRecipe(
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

      const personalResult = await savePersonalRecipe(state);

      if (!personalResult.saved || !personalResult.recipe) {
        return {
          allowed: personalResult.allowed,
          ...(personalResult.message ? { message: personalResult.message } : {}),
          ...(personalResult.reason ? { reason: personalResult.reason } : {}),
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
          ...(sharedResult.sharedRecipeId ? { sharedRecipeId: sharedResult.sharedRecipeId } : {})
        };
      }

      if (latestRef.current.shareMode === "all") {
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
    [savePersonalRecipe, shareRecipeRecord, upsertSharedRecipe]
  );

  const setShareMode = useCallback(
    async (mode: RecipeBookShareMode) => {
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
    [shareAllPersonalRecipes, unshareAllOwnedRecipes]
  );

  const shareRecipe = useCallback(
    async (id: string) => {
      const sourceRecord = getSavedRecipeRecordById(savedRecipesRef.current, id);

      if (!sourceRecord) {
        return {
          allowed: false,
          message: "This saved recipe is no longer available.",
          saved: false
        };
      }

      return shareRecipeRecord(sourceRecord);
    },
    [shareRecipeRecord]
  );

  const unshareRecipe = useCallback(
    async (id: string): Promise<SaveRecipeResult> => {
      const sourceRecord = getSavedRecipeRecordById(savedRecipesRef.current, id);

      if (!sourceRecord?.sharedRecipeId) {
        commitSavedRecipes((current) => markSavedRecipeUnshared(current, id));
        return {
          allowed: true,
          saved: true
        };
      }

      try {
        await latestRef.current.client.deleteSharedRecipe(sourceRecord.sharedRecipeId);
        removeSharedRecipeFromState(sourceRecord.sharedRecipeId);
        commitSavedRecipes((current) => markSavedRecipeUnshared(current, id));
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
    [commitSavedRecipes, removeSharedRecipeFromState]
  );

  const updateRecipe = useCallback(
    (id: string, update: SavedRecipeUpdate): boolean => {
      const sourceRecord = getSavedRecipeRecordById(savedRecipesRef.current, id);

      if (sourceRecord) {
        const nextRecord = {
          ...sourceRecord,
          notes: update.notes,
          recipe: update.recipe ?? sourceRecord.recipe,
          updatedAt: update.updatedAt ?? new Date().toISOString()
        };
        commitSavedRecipes((current) => updateSavedRecipeRecord(current, id, update));

        if (nextRecord.sharedRecipeId) {
          void syncSharedRecipeFromRecord(nextRecord);
        }
      }

      return sourceRecord != null;
    },
    [commitSavedRecipes, syncSharedRecipeFromRecord]
  );

  const updateSharedRecipe = useCallback(
    async (id: string, update: SavedRecipeUpdate): Promise<boolean> => {
      const sourceRecord = latestRef.current.sharedRecipes.find((entry) => entry.id === id);

      if (!sourceRecord) {
        return false;
      }

      try {
        const apiClient = latestRef.current.client;
        const payload: Parameters<typeof apiClient.updateSharedRecipe>[1] = {
          recipe: update.recipe,
          warnings: sourceRecord.warnings
        };

        if ("notes" in update) {
          payload.notes = update.notes ?? null;
        }

        const response = await apiClient.updateSharedRecipe(id, payload);
        upsertSharedRecipe(response.recipe);
        setSharedRecipeError(null);
        return true;
      } catch (error) {
        setSharedRecipeError(getSharedRecipeErrorMessage(error));
        return false;
      }
    },
    [upsertSharedRecipe]
  );

  const getSaveLimitStatus = useCallback(
    (options?: { isExistingRecord?: boolean }) =>
      computeSaveLimitStatus({ canUseSharedRecipeBook, savedRecipes, tier }, options),
    [canUseSharedRecipeBook, savedRecipes, tier]
  );
  const getSavedRecipeById = useCallback(
    (id: string) => getSavedRecipeRecordById(savedRecipes, id),
    [savedRecipes]
  );
  const getSavedRecipeBySourceUrl = useCallback(
    (sourceUrl: string) => getSavedRecipeRecordBySourceUrl(savedRecipes, sourceUrl),
    [savedRecipes]
  );
  const getSharedRecipeById = useCallback(
    (id: string) => sharedRecipes.find((entry) => entry.id === id),
    [sharedRecipes]
  );

  const state = useMemo<SavedRecipesState>(
    () => ({
      canUseSharedRecipeBook,
      getSaveLimitStatus,
      getSavedRecipeById,
      getSavedRecipeBySourceUrl,
      getSharedRecipeById,
      hasLoadedSavedRecipes,
      hasLoadedSharedRecipes,
      savedRecipes,
      sharedRecipeError,
      sharedRecipes,
      shareMode
    }),
    [
      canUseSharedRecipeBook,
      getSaveLimitStatus,
      getSavedRecipeById,
      getSavedRecipeBySourceUrl,
      getSharedRecipeById,
      hasLoadedSavedRecipes,
      hasLoadedSharedRecipes,
      savedRecipes,
      sharedRecipeError,
      sharedRecipes,
      shareMode
    ]
  );

  const actions = useMemo<SavedRecipesActions>(
    () => ({
      cloneRecipe,
      cloneSharedRecipe,
      deleteSharedRecipe,
      incrementRecipeTimesCooked,
      refreshSharedRecipes,
      removeRecipe,
      saveRecipe,
      saveRecipeToTargets,
      setRecipeFavorite,
      setShareMode,
      shareAllPersonalRecipes,
      shareRecipe,
      unshareRecipe,
      updateRecipe,
      updateSharedRecipe
    }),
    [
      cloneRecipe,
      cloneSharedRecipe,
      deleteSharedRecipe,
      incrementRecipeTimesCooked,
      refreshSharedRecipes,
      removeRecipe,
      saveRecipe,
      saveRecipeToTargets,
      setRecipeFavorite,
      setShareMode,
      shareAllPersonalRecipes,
      shareRecipe,
      unshareRecipe,
      updateRecipe,
      updateSharedRecipe
    ]
  );

  return (
    <SavedRecipesActionsContext.Provider value={actions}>
      <SavedRecipesStateContext.Provider value={state}>
        {children}
      </SavedRecipesStateContext.Provider>
    </SavedRecipesActionsContext.Provider>
  );
};

/** Actions only: stable identities, no re-render when the cookbook changes. */
export const useSavedRecipesActions = (): SavedRecipesActions => {
  const actions = useContext(SavedRecipesActionsContext);

  if (!actions) {
    throw new Error("useSavedRecipesActions must be used within SavedRecipesProvider.");
  }

  return actions;
};

export const useSavedRecipes = (): SavedRecipesContextValue => {
  const state = useContext(SavedRecipesStateContext);
  const actions = useContext(SavedRecipesActionsContext);
  const value = useMemo(
    () => (state && actions ? { ...state, ...actions } : null),
    [actions, state]
  );

  if (!value) {
    throw new Error("useSavedRecipes must be used within SavedRecipesProvider.");
  }

  return value;
};
