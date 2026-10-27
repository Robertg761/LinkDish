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
import { isUnreadableStoredList } from "../../lib/storedList";
import { isAccountChangedError } from "../account/account-changed-error";
import { useAccount } from "../account/AccountContext";
import { useBilling } from "../billing/BillingContext";
import { billingPlans } from "../billing/plans";
import { canSaveAnotherRecipe } from "../billing/store";

import {
  COLLECTIONS_CORRUPT_BACKUP_STORAGE_KEY,
  COLLECTIONS_STORAGE_KEY,
  CollectionValidationError,
  createCollectionRecord,
  getRecipeCollectionIds,
  parseCollections,
  removeCollectionFromRecords,
  setSavedRecipeCollectionIds,
  setSavedRecipeTags,
  sortCollections,
  updateCollectionRecord,
  type CollectionInput,
  type CollectionPatch,
  type MobileCollection
} from "./collections";
import { createCookbookStorage } from "./cookbookStorage";
import { CookbookSyncProvider } from "./CookbookSyncContext";
import {
  clearStateCollections,
  forgetSyncedCollections,
  readStateCollections
} from "./librarySync";
import {
  createScanVersion,
  deleteRecipeSourceImageFiles,
  persistRecipeSourceImages
} from "./sourceImageFiles";
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
  getOwnSharedRecipeId,
  recordSharedLinkOwners,
  markSavedRecipeUnshared,
  withOwnSharedLink,
  removeSavedRecipeRecord,
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

import type { RestorePlan } from "../backup/backup";
import type { BillingTier } from "../billing/plans";
import type { SuccessfulExtractionState } from "../recipe-results/types";
import type { HouseholdDetails, SharedRecipe } from "@linkdish/api-contracts";

export interface SavedRecipesState {
  canUseSharedRecipeBook: boolean;
  /** The cookbook's collections, in their display order. */
  collections: MobileCollection[];
  getSaveLimitStatus: (options?: { isExistingRecord?: boolean }) => SaveLimitStatus;
  getSavedRecipeById: (id: string) => SavedRecipeRecord | undefined;
  getSavedRecipeBySourceUrl: (sourceUrl: string) => SavedRecipeRecord | undefined;
  getSharedRecipeById: (id: string) => SharedRecipe | undefined;
  hasLoadedSavedRecipes: boolean;
  hasLoadedSharedRecipes: boolean;
  /**
   * Everything stored for the cookbook (recipes and collections) has loaded and could be read,
   * so what shows is the whole cookbook: a backup made now is complete, and a restore is allowed.
   */
  isCookbookReadable: boolean;
  savedRecipes: SavedRecipeRecord[];
  sharedRecipeError: string | null;
  sharedRecipes: SharedRecipe[];
  shareMode: RecipeBookShareMode;
}

export interface SavedRecipesActions {
  cloneRecipe: (id: string) => SaveRecipeResult & { recipeId?: string };
  cloneSharedRecipe: (id: string) => SaveRecipeResult & { recipeId?: string };
  /**
   * Adds a collection at the end. Throws CollectionValidationError for a bad name, or when the
   * stored collections couldn't be read.
   */
  createCollection: (input: CollectionInput) => MobileCollection;
  /** Deletes a collection and takes every recipe out of it (the recipes stay). */
  deleteCollection: (id: string) => void;
  deleteSharedRecipe: (id: string) => Promise<SaveRecipeResult>;
  incrementRecipeTimesCooked: (id: string) => boolean;
  refreshSharedRecipes: () => Promise<void>;
  removeRecipe: (id: string) => void;
  /**
   * Adds what `plan` decides a backup brings (see planBackupRestore), planned against the
   * cookbook as it is now, and saves the cookbook at once. A planned record whose id is already
   * here replaces that record. Returns the plan it applied, or null (changing nothing) when the
   * stored cookbook isn't readable (see isCookbookReadable).
   */
  restoreBackup: (
    plan: (cookbook: BackupRestoreCookbook) => RestorePlan
  ) => Promise<RestorePlan | null>;
  saveRecipe: (
    state: SuccessfulExtractionState
  ) => Promise<SaveRecipeResult & { recipeId?: string }>;
  saveRecipeToTargets: (
    state: SuccessfulExtractionState,
    target: "personal" | "family" | "both"
  ) => Promise<SaveRecipeResult & { recipeId?: string; sharedRecipeId?: string }>;
  /** Hearts or un-hearts a personal recipe. Returns false when the recipe is gone. */
  setRecipeFavorite: (id: string, favorite: boolean) => boolean;
  /** The collections a personal recipe is in. Returns false when the recipe is gone. */
  setRecipeCollections: (id: string, collectionIds: readonly string[]) => boolean;
  /** A personal recipe's tags (cleaned up and deduplicated). Returns false when it is gone. */
  setRecipeTags: (id: string, tags: readonly string[]) => boolean;
  setShareMode: (mode: RecipeBookShareMode) => Promise<void>;
  shareAllPersonalRecipes: () => Promise<SaveRecipeResult>;
  shareRecipe: (id: string) => Promise<SaveRecipeResult & { sharedRecipeId?: string }>;
  unshareRecipe: (id: string) => Promise<SaveRecipeResult>;
  /** Renames a collection or changes its emoji, description or place. Throws on a bad name. */
  updateCollection: (id: string, patch: CollectionPatch) => void;
  updateRecipe: (id: string, update: SavedRecipeUpdate) => boolean;
  updateSharedRecipe: (id: string, update: SavedRecipeUpdate) => Promise<boolean>;
}

export interface BackupRestoreCookbook {
  collections: MobileCollection[];
  /** Personal recipes that still fit (Infinity when there is no limit). */
  freeSlots: number;
  records: SavedRecipeRecord[];
}

export type SavedRecipesContextValue = SavedRecipesState & SavedRecipesActions;

const SavedRecipesStateContext = createContext<SavedRecipesState | null>(null);
const SavedRecipesActionsContext = createContext<SavedRecipesActions | null>(null);
const STARTER_RECIPES_SEEDED_STORAGE_KEY = "linkdish.starterRecipesSeeded.v1";
const RECIPE_BOOK_SHARE_MODE_STORAGE_KEY_PREFIX = "linkdish.recipeBookShareMode";
/**
 * Small edits (times cooked, a heart, a share flag) are written once they settle instead of on
 * every tap; the write is flushed when the app backgrounds. Each write stores only the recipes
 * that changed (see cookbookStorage.ts).
 */
export const SAVED_RECIPES_PERSIST_DEBOUNCE_MS = 400;

const getRecipeBookShareModeStorageKey = (
  userId: string,
  householdId: HouseholdDetails["id"]
): string => `${RECIPE_BOOK_SHARE_MODE_STORAGE_KEY_PREFIX}:${userId}:${householdId}`;

const parseRecipeBookShareMode = (value: string | null): RecipeBookShareMode =>
  value === "selected" || value === "all" || value === "none" ? value : "none";

/** Why a recipe saved just as someone else signed in (or out) wasn't shared with the Family. */
const ACCOUNT_CHANGED_MESSAGE = "you switched accounts while it was saving.";

/** Sharing (or unsharing) the whole book stopped because someone else signed in (or out). */
const ACCOUNT_CHANGED_RESULT: SaveRecipeResult = {
  allowed: false,
  message: "You switched accounts, so the rest of your recipes were left as they were.",
  saved: false
};

/** A Family change that finished after someone else signed in (or out): it isn't theirs. */
const SWITCHED_ACCOUNT_RESULT: SaveRecipeResult = {
  allowed: false,
  message: "You switched accounts before this finished.",
  saved: false
};

/** Shown while the Family state belongs to another account (stable, for memoized readers). */
const NO_SHARED_RECIPES: SharedRecipe[] = [];

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
const migrateLegacySourceImages = (records: SavedRecipeRecord[]): SavedRecipeRecord[] => {
  if (!records.some((record) => record.sourceImages?.some(isDataUrlSourceImage))) {
    return records;
  }

  return records.map((record) => {
    if (!record.sourceImages?.some(isDataUrlSourceImage)) {
      return record;
    }

    return {
      ...record,
      sourceImages: persistRecipeSourceImages(record.id, record.sourceImages)
    };
  });
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
  const { getAuthHeaders, getAuthHeadersFor, isSignedIn, user } = useAccount();
  const { tier } = useBilling();
  const [hasLoadedSavedRecipes, setHasLoadedSavedRecipes] = useState(false);
  const [hasLoadedSharedRecipesState, setHasLoadedSharedRecipes] = useState(false);
  const [savedRecipes, setSavedRecipes] = useState<SavedRecipeRecord[]>([]);
  const [hasUnreadableStoredRecipes, setHasUnreadableStoredRecipes] = useState(false);
  /** The stored cookbook couldn't be read at all: what shows isn't it, so nothing syncs. */
  const [cookbookReadFailed, setCookbookReadFailed] = useState(false);
  const [sharedRecipesState, setSharedRecipes] = useState<SharedRecipe[]>([]);
  const [sharedRecipeErrorState, setSharedRecipeError] = useState<string | null>(null);
  const [shareMode, setShareModeState] = useState<RecipeBookShareMode>("none");
  const [activeHouseholdIdState, setActiveHouseholdId] = useState<HouseholdDetails["id"] | null>(
    null
  );
  /** The account the Family state above was loaded for (null: signed out). */
  const [familyStateOwner, setFamilyStateOwner] = useState<string | null>(null);
  const familyStateOwnerRef = useRef<string | null>(null);
  const familyAccount = isSignedIn && user ? user.id : null;
  // Another account signed in (a direct switch): the last one's Family recipes, household and
  // error are never shown, not even for the renders before this account's refresh starts.
  const familyStateIsCurrent = familyStateOwner === familyAccount;
  const sharedRecipes = familyStateIsCurrent ? sharedRecipesState : NO_SHARED_RECIPES;
  const sharedRecipeError = familyStateIsCurrent ? sharedRecipeErrorState : null;
  const activeHouseholdId = familyStateIsCurrent ? activeHouseholdIdState : null;
  const hasLoadedSharedRecipes = familyStateIsCurrent && hasLoadedSharedRecipesState;
  const [hasLoadedShareMode, setHasLoadedShareMode] = useState(false);
  const savedRecipesRef = useRef<SavedRecipeRecord[]>([]);
  const [collections, setCollections] = useState<MobileCollection[]>([]);
  const [hasLoadedCollections, setHasLoadedCollections] = useState(false);
  /** The collections couldn't be read: none are written (or synced) over the stored copy. */
  const [collectionsReadFailed, setCollectionsReadFailed] = useState(false);
  const collectionsReadFailedRef = useRef(collectionsReadFailed);
  collectionsReadFailedRef.current = collectionsReadFailed;
  const collectionsRef = useRef<MobileCollection[]>([]);
  /** Bumped by every Family refresh, so only the newest one lands. */
  const sharedRefreshRef = useRef(0);
  const cookbookStorage = useMemo(
    () => createCookbookStorage(undefined, { prepareLegacyRecords: migrateLegacySourceImages }),
    []
  );
  const client = useMemo(
    () =>
      createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        // Family requests go out only as the account this render is for: an action holds this
        // client from its start, so one Clerk switches to meanwhile is never sent its changes.
        getHeaders: user ? getAuthHeadersFor(user.id) : getAuthHeaders
      }),
    [getAuthHeaders, getAuthHeadersFor, user]
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
    hasLoadedSharedRecipes,
    isSignedIn,
    sharedRecipes,
    shareMode,
    tier,
    userId: user?.id
  });
  latestRef.current = {
    canUseSharedRecipeBook,
    client,
    hasLoadedSharedRecipes,
    isSignedIn,
    sharedRecipes,
    shareMode,
    tier,
    userId: user?.id
  };

  /**
   * The Family copy `record` links to, when that link is the signed-in account's own (see
   * getOwnSharedRecipeId): the cookbook is this device's, but a link belongs to who shared it.
   */
  const ownSharedRecipeId = useCallback(
    (record: Pick<SavedRecipeRecord, "sharedByUserId" | "sharedRecipeId">) => {
      const { hasLoadedSharedRecipes: loaded, sharedRecipes: family, userId } = latestRef.current;
      return getOwnSharedRecipeId(record, userId, loaded ? family : null);
    },
    []
  );

  /** Every cookbook change goes through here; the ref is always the latest list. */
  const commitSavedRecipes = useCallback(
    (update: (records: SavedRecipeRecord[]) => SavedRecipeRecord[]) => {
      savedRecipesRef.current = update(savedRecipesRef.current);
      setSavedRecipes(savedRecipesRef.current);
    },
    []
  );

  /** Every collections change goes through here; the ref is always the latest list. */
  const commitCollections = useCallback(
    (update: (current: MobileCollection[]) => MobileCollection[]) => {
      const next = update(collectionsRef.current);

      if (next !== collectionsRef.current) {
        collectionsRef.current = sortCollections(next);
        setCollections(collectionsRef.current);
      }
    },
    []
  );

  const collectionsWriter = useMemo(
    () =>
      createDebouncedWriter<MobileCollection[]>(
        (value) => AsyncStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(value)),
        SAVED_RECIPES_PERSIST_DEBOUNCE_MS,
        (error) => {
          console.warn("Failed to persist collections.", error);
        }
      ),
    []
  );

  const writer = useMemo(
    () =>
      createDebouncedWriter<SavedRecipeRecord[]>(
        // Writes only what changed, so one an explicit save already wrote is skipped.
        (records) => cookbookStorage.write(records),
        SAVED_RECIPES_PERSIST_DEBOUNCE_MS,
        (error) => {
          console.warn("Failed to persist saved recipes.", error);
        }
      ),
    [cookbookStorage]
  );

  /** The cookbook as cloud sync reads and changes it (see CookbookSyncProvider). */
  const syncedCookbook = useMemo(
    () => ({
      commitCollections,
      commitRecords: commitSavedRecipes,
      getCollections: () => collectionsRef.current,
      getRecords: () => savedRecipesRef.current,
      persist: async (removed: readonly SavedRecipeRecord[]) => {
        // Stored before the sync records that the cloud's copy is in the cookbook, so a crash
        // can't leave it believing that of a cookbook that was never written.
        await Promise.all([
          writer.writeNow(savedRecipesRef.current),
          collectionsWriter.writeNow(collectionsRef.current)
        ]);
        const orphanedScanUris = getOrphanedSourceImageUris(savedRecipesRef.current, [...removed]);

        if (orphanedScanUris.length > 0) {
          deleteRecipeSourceImageFiles(orphanedScanUris);
        }
      }
    }),
    [collectionsWriter, commitCollections, commitSavedRecipes, writer]
  );
  const createSyncClient = useCallback(
    (account: string) =>
      createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        // Sent only as the account the sync is for.
        getHeaders: getAuthHeadersFor(account)
      }),
    [getAuthHeadersFor]
  );

  const refreshSharedRecipes = useCallback(async () => {
    // Only the newest refresh, for the account signed in now, lands: one started for another
    // account (signed in before a direct switch) never shows its recipes or household here.
    const refresh = ++sharedRefreshRef.current;
    const startedFor = isSignedIn ? user?.id : undefined;
    const stale = () =>
      refresh !== sharedRefreshRef.current || latestRef.current.userId !== startedFor;

    // The Family state belongs to this account from now on; another's is cleared first.
    const owner = startedFor ?? null;

    if (familyStateOwnerRef.current !== owner) {
      setSharedRecipes([]);
      setActiveHouseholdId(null);
      setSharedRecipeError(null);
    }

    familyStateOwnerRef.current = owner;
    setFamilyStateOwner(owner);

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

      if (stale()) {
        return;
      }

      nextHouseholdId = householdResponse.household?.id ?? null;
      setActiveHouseholdId(nextHouseholdId);

      if (!nextHouseholdId) {
        setSharedRecipes([]);
        setSharedRecipeError(null);
        return;
      }

      const response = await client.getSharedRecipes();

      if (stale()) {
        return;
      }

      setSharedRecipes(response.recipes);
      setSharedRecipeError(null);
    } catch (error) {
      // Not sent: another account signed in first. Its own refresh follows.
      if (stale() || isAccountChangedError(error)) {
        return;
      }

      if (!nextHouseholdId) {
        setActiveHouseholdId(null);
      }
      setSharedRecipes([]);
      setSharedRecipeError(getSharedRecipeErrorMessage(error));
    } finally {
      if (!stale()) {
        setHasLoadedSharedRecipes(true);
      }
    }
  }, [client, isSignedIn, user]);

  useEffect(() => {
    let isMounted = true;

    const hydrateSavedRecipes = async () => {
      try {
        const [{ incomplete, records: loadedRecipes, status }, storedSeeded] = await Promise.all([
          cookbookStorage.read(),
          AsyncStorage.getItem(STARTER_RECIPES_SEEDED_STORAGE_KEY)
        ]);

        if (!isMounted) {
          return;
        }

        if (status === "corrupt") {
          setHasUnreadableStoredRecipes(true);
        }

        // Stored recipes that couldn't be read aren't in what shows, so nothing syncs.
        if (incomplete) {
          setCookbookReadFailed(true);
        }

        // Inlined scans were moved to files by the storage read (prepareLegacyRecords). Seeding is
        // stored by the write that follows the load, which skips recipes stored as they are.
        const shouldSeedStarterRecipes =
          status !== "corrupt" && loadedRecipes.length === 0 && storedSeeded !== "true";
        const hydratedRecipes = shouldSeedStarterRecipes
          ? createStarterRecipeSeedRecords().map(starterRecipeSeedRecordToSavedRecipeRecord)
          : loadedRecipes;

        if (status !== "corrupt" && storedSeeded !== "true") {
          await AsyncStorage.setItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");
        }

        if (!isMounted) {
          return;
        }

        commitSavedRecipes((current) =>
          current.reduce(
            (accumulator, entry) => upsertSavedRecipeRecord(accumulator, entry),
            hydratedRecipes
          )
        );
      } catch (error) {
        console.warn("Failed to load saved recipes.", error);

        if (isMounted) {
          setCookbookReadFailed(true);
        }
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
  }, [commitSavedRecipes, cookbookStorage]);

  useEffect(() => {
    let isMounted = true;

    Promise.all([
      AsyncStorage.getItem(COLLECTIONS_STORAGE_KEY),
      readStateCollections().catch((error: unknown) => {
        console.warn("Failed to read collections left in the sync state.", error);
        return [];
      })
    ])
      .then(async ([stored, fromSyncState]) => {
        // Collections that can't be read are copied aside first; if that fails, nothing is written.
        if (isUnreadableStoredList(stored)) {
          await AsyncStorage.setItem(COLLECTIONS_CORRUPT_BACKUP_STORAGE_KEY, stored!);
          // Sync forgets them too, so it brings the cloud's back rather than deleting them there.
          await forgetSyncedCollections();
        }

        if (isMounted) {
          // Anything a sync or the cook changed before this read landed is kept.
          commitCollections((current) => {
            const known = new Set(current.map((collection) => collection.id));
            const loaded = [...parseCollections(stored ?? null), ...fromSyncState].filter(
              (collection) => {
                const isNew = !known.has(collection.id);
                known.add(collection.id);
                return isNew;
              }
            );
            return [...current, ...loaded];
          });

          // They live in the cookbook now: once saved here, they leave the sync state, so one
          // deleted later can't come back from there.
          if (fromSyncState.length > 0) {
            try {
              await collectionsWriter.writeNow(collectionsRef.current);
              await clearStateCollections();
            } catch (error) {
              console.warn("Failed to move collections out of the sync state.", error);
            }
          }
        }
      })
      .catch((error: unknown) => {
        console.warn("Failed to load collections.", error);

        if (isMounted) {
          setCollectionsReadFailed(true);
        }
      })
      .finally(() => {
        if (isMounted) {
          setHasLoadedCollections(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [collectionsWriter, commitCollections]);

  useEffect(() => {
    if (hasLoadedCollections && !collectionsReadFailed) {
      collectionsWriter.schedule(collections);
    }
  }, [collections, collectionsReadFailed, collectionsWriter, hasLoadedCollections]);

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

  // Once this account's Family list shows whose copy a link from before sharers were recorded is,
  // store that on the link, so it reads right wherever the list isn't at hand.
  useEffect(() => {
    if (hasLoadedSavedRecipes && hasLoadedSharedRecipes && sharedRecipes.length > 0) {
      commitSavedRecipes((current) => recordSharedLinkOwners(current, sharedRecipes));
    }
  }, [commitSavedRecipes, hasLoadedSavedRecipes, hasLoadedSharedRecipes, sharedRecipes]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        void writer.flush().catch((error: unknown) => {
          console.warn("Failed to persist saved recipes.", error);
        });
        void collectionsWriter.flush().catch((error: unknown) => {
          console.warn("Failed to persist collections.", error);
        });
      }
    });

    return () => {
      subscription.remove();
      void writer.flush().catch(() => undefined);
      void collectionsWriter.flush().catch(() => undefined);
    };
  }, [collectionsWriter, writer]);

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
      const { client: apiClient, isSignedIn: signedIn, userId: startedFor } = latestRef.current;
      /** Someone else signed in (or out) while it shared: what it answers isn't theirs. */
      const switched = () => latestRef.current.userId !== startedFor;

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

      // Another account's link on this recipe isn't this one's to update: this account shares
      // its own copy.
      const ownId = ownSharedRecipeId(record);

      try {
        if (ownId) {
          const response = await apiClient.updateSharedRecipe(ownId, {
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

          if (switched()) {
            return SWITCHED_ACCOUNT_RESULT;
          }

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

        if (switched()) {
          return SWITCHED_ACCOUNT_RESULT;
        }

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
        if (switched() || isAccountChangedError(error)) {
          return SWITCHED_ACCOUNT_RESULT;
        }

        const message = getSharedRecipeErrorMessage(error);
        setSharedRecipeError(message);

        return {
          allowed: false,
          message,
          saved: false
        };
      }
    },
    [commitSavedRecipes, ownSharedRecipeId, upsertSharedRecipe]
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
      // New files for this save's scans: the ones the stored record (or a clone) uses stay as
      // they are unless the cookbook that points at the new ones is written.
      const sourceImages = persistRecipeSourceImages(recordId, createdRecord.sourceImages, {
        version: createScanVersion()
      });
      const writtenScanUris = (sourceImages ?? [])
        .map((image) => image.uri)
        .filter((uri) => !createdRecord.sourceImages?.some((image) => image.uri === uri));
      const nextRecord: SavedRecipeRecord = {
        ...createdRecord,
        favorite: existingRecord?.favorite,
        id: recordId,
        sharedAt: existingRecord?.sharedAt,
        sharedByUserId: existingRecord?.sharedByUserId,
        sharedRecipeId: existingRecord?.sharedRecipeId,
        sourceImages,
        timesCooked: existingRecord?.timesCooked ?? createdRecord.timesCooked
      };
      const nextRecipes = upsertSavedRecipeRecord(savedRecipesRef.current, nextRecord);

      // Persist before reporting success: a swallowed write failure used to leave
      // the recipe looking saved until the next launch, when it was simply gone.
      try {
        await writer.writeNow(nextRecipes);
      } catch (error) {
        console.warn("Failed to persist saved recipes.", error);
        // Nothing stored points at this save's scans: they go, so a retry leaves none behind.
        deleteRecipeSourceImageFiles(writtenScanUris);

        return {
          allowed: true,
          message: "This recipe could not be saved to your Cookbook. Please try again.",
          reason: "persist_failed",
          saved: false
        };
      }

      setHasUnreadableStoredRecipes(false);

      // Written as the cookbook was when the save began: a favorite, a cook, a Family share or a
      // delete made to this recipe while it was written wins over that snapshot.
      const latestRecord = getSavedRecipeRecordById(savedRecipesRef.current, recordId);

      if (existingRecord && !latestRecord) {
        // Its new scans go too, once the cookbook without it is written.
        const orphanedScanUris = getOrphanedSourceImageUris(savedRecipesRef.current, [nextRecord]);
        void writer.writeNow(savedRecipesRef.current).then(
          () => deleteRecipeSourceImageFiles(orphanedScanUris),
          (error: unknown) => console.warn("Failed to persist saved recipes.", error)
        );

        return {
          allowed: true,
          message: "This recipe was deleted from your Cookbook while it was saving.",
          saved: false
        };
      }

      const savedRecord: SavedRecipeRecord = latestRecord
        ? {
            ...nextRecord,
            favorite: latestRecord.favorite,
            sharedAt: latestRecord.sharedAt,
            sharedByUserId: latestRecord.sharedByUserId,
            sharedRecipeId: latestRecord.sharedRecipeId,
            timesCooked: latestRecord.timesCooked
          }
        : nextRecord;
      commitSavedRecipes((current) => upsertSavedRecipeRecord(current, savedRecord));

      // The scans this recipe had before, now that nothing uses them (a clone may still).
      if (existingRecord) {
        deleteRecipeSourceImageFiles(
          getOrphanedSourceImageUris(savedRecipesRef.current, [existingRecord])
        );
      }

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
        recipe: savedRecord,
        recipeId: savedRecord.id,
        saved: true
      };
    },
    [commitSavedRecipes, getLatestSaveLimitStatus, writer]
  );

  const shareAllPersonalRecipes = useCallback(async (): Promise<SaveRecipeResult> => {
    const startedFor = latestRef.current.userId;

    for (const recipe of savedRecipesRef.current.filter((entry) => !entry.isStarter)) {
      // Never carry on into the household of someone who signed in meanwhile.
      if (latestRef.current.userId !== startedFor) {
        return ACCOUNT_CHANGED_RESULT;
      }

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
        // Never carry on as someone who signed in meanwhile.
        if (latestRef.current.userId !== userId) {
          return ACCOUNT_CHANGED_RESULT;
        }

        await apiClient.deleteSharedRecipe(sharedRecipeId);
      }

      if (latestRef.current.userId !== userId) {
        return ACCOUNT_CHANGED_RESULT;
      }

      setSharedRecipes((current) => current.filter((recipe) => recipe.ownerUserId !== userId));
      // Only this account's links: another account's on this device stay that account's.
      commitSavedRecipes((current) =>
        current.map((entry) =>
          getOwnSharedRecipeId(entry, userId, currentShared)
            ? {
                ...entry,
                sharedAt: undefined,
                sharedByUserId: undefined,
                sharedRecipeId: undefined
              }
            : entry
        )
      );
      setSharedRecipeError(null);

      return {
        allowed: true,
        saved: true
      };
    } catch (error) {
      if (latestRef.current.userId !== userId || isAccountChangedError(error)) {
        return ACCOUNT_CHANGED_RESULT;
      }

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
      const { client: apiClient, isSignedIn: signedIn, userId: startedFor } = latestRef.current;
      const switched = () => latestRef.current.userId !== startedFor;

      const ownId = ownSharedRecipeId(record);

      if (!ownId || !signedIn) {
        return;
      }

      try {
        const response = await apiClient.updateSharedRecipe(ownId, {
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

        // Someone else signed in (or out) meanwhile: the Family copy they see isn't this one.
        if (switched()) {
          return;
        }

        upsertSharedRecipe(response.recipe);
        commitSavedRecipes((current) => markSavedRecipeShared(current, record.id, response.recipe));
        setSharedRecipeError(null);
      } catch (error) {
        if (!switched() && !isAccountChangedError(error)) {
          setSharedRecipeError(getSharedRecipeErrorMessage(error));
        }
      }
    },
    [commitSavedRecipes, ownSharedRecipeId, upsertSharedRecipe]
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
      const startedFor = latestRef.current.userId;

      try {
        await latestRef.current.client.deleteSharedRecipe(id);

        if (latestRef.current.userId !== startedFor) {
          return SWITCHED_ACCOUNT_RESULT;
        }

        removeSharedRecipeFromState(id);
        setSharedRecipeError(null);

        return {
          allowed: true,
          saved: true
        };
      } catch (error) {
        if (latestRef.current.userId !== startedFor || isAccountChangedError(error)) {
          return SWITCHED_ACCOUNT_RESULT;
        }

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

  const setRecipeTags = useCallback(
    (id: string, tags: readonly string[]): boolean => {
      if (!getSavedRecipeRecordById(savedRecipesRef.current, id)) {
        return false;
      }

      commitSavedRecipes((current) => setSavedRecipeTags(current, id, tags));
      return true;
    },
    [commitSavedRecipes]
  );

  const setRecipeCollections = useCallback(
    (id: string, collectionIds: readonly string[]): boolean => {
      if (!getSavedRecipeRecordById(savedRecipesRef.current, id)) {
        return false;
      }

      commitSavedRecipes((current) => setSavedRecipeCollectionIds(current, id, collectionIds));
      return true;
    },
    [commitSavedRecipes]
  );

  const createCollection = useCallback(
    (input: CollectionInput): MobileCollection => {
      // Collections that couldn't be read aren't saved to, so a new one would vanish on restart.
      if (collectionsReadFailedRef.current) {
        throw new CollectionValidationError(
          "Your collections couldn't be loaded on this phone. Close and reopen LinkDish to try again."
        );
      }

      const created = createCollectionRecord(collectionsRef.current, input);
      commitCollections((current) => [...current, created]);
      trackMobileEvent({
        eventName: "collection_created",
        routeOrScreen: "cookbook",
        properties: {
          collection_count: collectionsRef.current.length,
          has_emoji: Boolean(created.emoji)
        }
      });
      return created;
    },
    [commitCollections]
  );

  const updateCollection = useCallback(
    (id: string, patch: CollectionPatch) => {
      const existing = collectionsRef.current.find((collection) => collection.id === id);

      if (!existing) {
        return;
      }

      const updated = updateCollectionRecord(existing, patch);
      commitCollections((current) =>
        current.map((collection) => (collection.id === id ? updated : collection))
      );
    },
    [commitCollections]
  );

  const deleteCollection = useCallback(
    (id: string) => {
      commitSavedRecipes((current) => removeCollectionFromRecords(current, id));
      commitCollections((current) => current.filter((collection) => collection.id !== id));
    },
    [commitCollections, commitSavedRecipes]
  );

  const isCookbookReadable =
    hasLoadedSavedRecipes &&
    hasLoadedCollections &&
    !hasUnreadableStoredRecipes &&
    !cookbookReadFailed &&
    !collectionsReadFailed;
  const isCookbookReadableRef = useRef(isCookbookReadable);
  isCookbookReadableRef.current = isCookbookReadable;

  const restoreBackup = useCallback(
    async (plan: (cookbook: BackupRestoreCookbook) => RestorePlan): Promise<RestorePlan | null> => {
      // Restoring into a cookbook that isn't all here would save the restored copy over the one
      // that couldn't be read.
      if (!isCookbookReadableRef.current) {
        return null;
      }

      const { canUseSharedRecipeBook: unlimited, tier } = latestRef.current;
      const limit = billingPlans[tier].limits.savedRecipes;
      const applied = plan({
        collections: collectionsRef.current,
        freeSlots:
          unlimited || limit == null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, limit - getQuotaSavedRecipeCount(savedRecipesRef.current)),
        records: savedRecipesRef.current
      });

      if (applied.collections.length > 0) {
        commitCollections((current) => {
          const known = new Set(current.map((collection) => collection.id));
          return [...current, ...applied.collections.filter((entry) => !known.has(entry.id))];
        });
      }

      if (applied.records.length > 0 || applied.membershipAdditions.length > 0) {
        commitSavedRecipes((current) => {
          // A record with an id already here replaces it (a starter nobody touched; see
          // planBackupRestore); the rest are new.
          const byId = new Map(applied.records.map((record) => [record.id, record]));
          const known = new Set(current.map((record) => record.id));
          let next = [
            ...applied.records.filter((record) => !known.has(record.id)),
            ...current.map((record) => byId.get(record.id) ?? record)
          ];

          for (const { collectionIds, recipeId } of applied.membershipAdditions) {
            const record = getSavedRecipeRecordById(next, recipeId);

            if (record) {
              next = setSavedRecipeCollectionIds(next, recipeId, [
                ...getRecipeCollectionIds(record),
                ...collectionIds
              ]);
            }
          }

          return next;
        });
      }

      await Promise.all([
        writer.writeNow(savedRecipesRef.current),
        collectionsWriter.writeNow(collectionsRef.current)
      ]);

      return applied;
    },
    [collectionsWriter, commitCollections, commitSavedRecipes, writer]
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
      const startedFor = latestRef.current.userId;
      const result = await savePersonalRecipe(state);

      // Shared as the account that saved it: never into the household of one that signed in (or
      // with the share setting of one) while the cookbook was being written.
      if (
        result.saved &&
        result.recipe &&
        latestRef.current.userId === startedFor &&
        latestRef.current.shareMode === "all"
      ) {
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
        const sharedFor = latestRef.current.userId;

        try {
          const response = await latestRef.current.client.createSharedRecipe(
            successStateToSharedRecipeRequest(state)
          );

          if (latestRef.current.userId !== sharedFor) {
            return SWITCHED_ACCOUNT_RESULT;
          }

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
          if (latestRef.current.userId !== sharedFor || isAccountChangedError(error)) {
            return SWITCHED_ACCOUNT_RESULT;
          }

          const message = getSharedRecipeErrorMessage(error);
          setSharedRecipeError(message);

          return {
            allowed: false,
            message,
            saved: false
          };
        }
      }

      const startedFor = latestRef.current.userId;
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

      // Someone else signed in (or out) while the cookbook was being written: the recipe is saved
      // on this phone, but never shared into their household (or as a signed-out visitor).
      if (latestRef.current.userId !== startedFor) {
        return {
          allowed: true,
          ...(target === "both"
            ? { message: buildPartialShareMessage(ACCOUNT_CHANGED_MESSAGE) }
            : {}),
          ...(personalResult.recipeId ? { recipeId: personalResult.recipeId } : {}),
          saved: true
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

      const ownId = sourceRecord ? ownSharedRecipeId(sourceRecord) : undefined;

      // Not shared by this account (another account's link stays that account's): nothing to do.
      if (!ownId) {
        return {
          allowed: true,
          saved: true
        };
      }

      const startedFor = latestRef.current.userId;

      try {
        await latestRef.current.client.deleteSharedRecipe(ownId);

        if (latestRef.current.userId !== startedFor) {
          return SWITCHED_ACCOUNT_RESULT;
        }

        removeSharedRecipeFromState(ownId);
        commitSavedRecipes((current) => markSavedRecipeUnshared(current, id));
        setSharedRecipeError(null);

        return {
          allowed: true,
          saved: true
        };
      } catch (error) {
        if (latestRef.current.userId !== startedFor || isAccountChangedError(error)) {
          return SWITCHED_ACCOUNT_RESULT;
        }

        const message = getSharedRecipeErrorMessage(error);
        setSharedRecipeError(message);

        return {
          allowed: false,
          message,
          saved: false
        };
      }
    },
    [commitSavedRecipes, ownSharedRecipeId, removeSharedRecipeFromState]
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

      const startedFor = latestRef.current.userId;

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

        // Someone else signed in (or out) meanwhile: this Family recipe isn't in their list.
        if (latestRef.current.userId !== startedFor) {
          return false;
        }

        upsertSharedRecipe(response.recipe);
        setSharedRecipeError(null);
        return true;
      } catch (error) {
        if (latestRef.current.userId === startedFor && !isAccountChangedError(error)) {
          setSharedRecipeError(getSharedRecipeErrorMessage(error));
        }

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
  // The cookbook as the signed-in account sees it: another account's Family link on a recipe
  // reads as not shared (it can't update or unshare that account's copy).
  const visibleSavedRecipes = useMemo(() => {
    const family = hasLoadedSharedRecipes ? sharedRecipes : null;
    return savedRecipes.map((record) => withOwnSharedLink(record, user?.id, family));
  }, [hasLoadedSharedRecipes, savedRecipes, sharedRecipes, user?.id]);
  const getSavedRecipeById = useCallback(
    (id: string) => getSavedRecipeRecordById(visibleSavedRecipes, id),
    [visibleSavedRecipes]
  );
  const getSavedRecipeBySourceUrl = useCallback(
    (sourceUrl: string) => getSavedRecipeRecordBySourceUrl(visibleSavedRecipes, sourceUrl),
    [visibleSavedRecipes]
  );
  const getSharedRecipeById = useCallback(
    (id: string) => sharedRecipes.find((entry) => entry.id === id),
    [sharedRecipes]
  );

  const state = useMemo<SavedRecipesState>(
    () => ({
      canUseSharedRecipeBook,
      collections,
      getSaveLimitStatus,
      getSavedRecipeById,
      getSavedRecipeBySourceUrl,
      getSharedRecipeById,
      hasLoadedSavedRecipes,
      hasLoadedSharedRecipes,
      isCookbookReadable,
      savedRecipes: visibleSavedRecipes,
      sharedRecipeError,
      sharedRecipes,
      shareMode
    }),
    [
      canUseSharedRecipeBook,
      collections,
      getSaveLimitStatus,
      getSavedRecipeById,
      getSavedRecipeBySourceUrl,
      getSharedRecipeById,
      hasLoadedSavedRecipes,
      hasLoadedSharedRecipes,
      isCookbookReadable,
      sharedRecipeError,
      sharedRecipes,
      shareMode,
      visibleSavedRecipes
    ]
  );

  const actions = useMemo<SavedRecipesActions>(
    () => ({
      cloneRecipe,
      cloneSharedRecipe,
      createCollection,
      deleteCollection,
      deleteSharedRecipe,
      incrementRecipeTimesCooked,
      refreshSharedRecipes,
      removeRecipe,
      restoreBackup,
      saveRecipe,
      saveRecipeToTargets,
      setRecipeCollections,
      setRecipeFavorite,
      setRecipeTags,
      setShareMode,
      shareAllPersonalRecipes,
      shareRecipe,
      unshareRecipe,
      updateCollection,
      updateRecipe,
      updateSharedRecipe
    }),
    [
      cloneRecipe,
      cloneSharedRecipe,
      createCollection,
      deleteCollection,
      deleteSharedRecipe,
      incrementRecipeTimesCooked,
      refreshSharedRecipes,
      removeRecipe,
      restoreBackup,
      saveRecipe,
      saveRecipeToTargets,
      setRecipeCollections,
      setRecipeFavorite,
      setRecipeTags,
      setShareMode,
      shareAllPersonalRecipes,
      shareRecipe,
      unshareRecipe,
      updateCollection,
      updateRecipe,
      updateSharedRecipe
    ]
  );

  return (
    <SavedRecipesActionsContext.Provider value={actions}>
      <SavedRecipesStateContext.Provider value={state}>
        <CookbookSyncProvider
          account={familyAccount}
          collections={collections}
          cookbook={syncedCookbook}
          createClient={createSyncClient}
          hasLoaded={isCookbookReadable}
          savedRecipes={savedRecipes}
        >
          {children}
        </CookbookSyncProvider>
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
