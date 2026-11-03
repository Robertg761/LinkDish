import { ExtractorApiError } from "@linkdish/api-client";
import { LibrarySyncCancelledError } from "@linkdish/recipe-domain/src/library-sync";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { AppState } from "react-native";

import { isAccountChangedError } from "../account/account-changed-error";

import {
  countMobileChangesNotSynced,
  replaceMobileLibrary,
  syncMobileLibrary,
  type MobileLibraryCookbook
} from "./librarySync";

import type { MobileCollection } from "./collections";
import type { SavedRecipeRecord } from "./store";
import type { ExtractorApiClient } from "@linkdish/api-client";

export type CookbookSyncPhase =
  /** Signed out, cloud sync isn't switched on, or it hasn't run yet: nothing to show. */
  | "off"
  | "syncing"
  | "synced"
  | "offline"
  | "error"
  /** The cookbook on this device is linked to another account and syncs with that one only. */
  | "other_account";

export interface CookbookSyncValue {
  phase: CookbookSyncPhase;
  /** When the cookbook last finished syncing (ms since the epoch). */
  lastSyncedAt: number | null;
  /** Recipes and collections the cloud turned away (too large, or past a limit). */
  held: number;
  syncNow: () => Promise<void>;
  /** Changes made here that the account the cookbook is linked to doesn't have yet. */
  countChangesNotSynced: () => Promise<number>;
  /** Replaces this device's cookbook (another account's) with the signed-in account's. */
  switchToAccountCookbook: () => Promise<void>;
}

/** A change here waits this long for more before it is synced. */
export const COOKBOOK_SYNC_DELAY_MS = 4_000;
const WAKE_THROTTLE_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000;
/** How long sync stays quiet after the API said it is switched off. */
const UNAVAILABLE_RETRY_MS = 30 * 60_000;

const CookbookSyncContext = createContext<CookbookSyncValue | null>(null);

interface CookbookSyncProviderProps extends PropsWithChildren {
  /** The signed-in account (null when signed out). */
  account: string | null;
  /** The cookbook's collections as rendered: a change here starts a sync too. */
  collections: readonly MobileCollection[];
  /** A client whose requests carry `account` only. */
  createClient: (
    account: string
  ) => Pick<ExtractorApiClient, "pullLibraryChanges" | "pushLibraryChanges">;
  cookbook: MobileLibraryCookbook;
  /** The cookbook has been read from storage: nothing syncs before. */
  hasLoaded: boolean;
  /** The cookbook as rendered: a change here starts a sync. */
  savedRecipes: readonly SavedRecipeRecord[];
}

const isOfflineError = (error: unknown): boolean =>
  error instanceof ExtractorApiError && (error.kind === "network" || error.kind === "timeout");

/**
 * Cloud sync of the signed-in account's cookbook (see ./librarySync): after changes here, when the
 * app comes to the foreground, on sign-in and on a slow poll while the app is open.
 */
export const CookbookSyncProvider = ({
  account,
  children,
  collections,
  cookbook,
  createClient,
  hasLoaded,
  savedRecipes
}: CookbookSyncProviderProps) => {
  const [status, setStatus] = useState<
    Pick<CookbookSyncValue, "held" | "lastSyncedAt" | "phase"> & { account: string | null }
  >({ account: null, held: 0, lastSyncedAt: null, phase: "off" });
  const accountRef = useRef(account);
  accountRef.current = account;
  const createClientRef = useRef(createClient);
  createClientRef.current = createClient;
  const inflightRef = useRef<Promise<void> | null>(null);
  const againRef = useRef(false);
  const unavailableUntilRef = useRef(0);
  /** The cookbook as the last sync left it: that change needs no sync of its own. */
  const syncedRecordsRef = useRef<readonly SavedRecipeRecord[] | null>(null);
  const syncedCollectionsRef = useRef<readonly MobileCollection[] | null>(null);

  const runFor = useCallback(
    async (runAccount: string) => {
      const isCurrent = () => accountRef.current === runAccount;
      setStatus((current) => ({ ...current, account: runAccount, phase: "syncing" }));

      try {
        const outcome = await syncMobileLibrary({
          account: runAccount,
          client: createClientRef.current(runAccount),
          cookbook,
          isCurrent
        });

        if (!isCurrent()) {
          return;
        }

        syncedRecordsRef.current = cookbook.getRecords();
        syncedCollectionsRef.current = cookbook.getCollections();
        setStatus((current) =>
          outcome.status === "other_account"
            ? { ...current, phase: "other_account" }
            : {
                account: runAccount,
                held: outcome.held,
                lastSyncedAt: Date.now(),
                phase: "synced"
              }
        );
      } catch (error) {
        if (
          !isCurrent() ||
          error instanceof LibrarySyncCancelledError ||
          isAccountChangedError(error)
        ) {
          return;
        }

        if (error instanceof ExtractorApiError && error.statusCode === 404) {
          unavailableUntilRef.current = Date.now() + UNAVAILABLE_RETRY_MS;
          setStatus((current) => ({ ...current, phase: "off" }));
          return;
        }

        if (!isOfflineError(error)) {
          console.warn("LinkDish couldn't sync the cookbook.", error);
        }

        setStatus((current) => ({
          ...current,
          phase: isOfflineError(error) ? "offline" : "error"
        }));
      }
    },
    [cookbook]
  );

  const syncNow = useCallback((): Promise<void> => {
    const runAccount = accountRef.current;

    if (!runAccount || Date.now() < unavailableUntilRef.current) {
      return Promise.resolve();
    }

    if (inflightRef.current) {
      againRef.current = true;
      return inflightRef.current.then(() => inflightRef.current ?? undefined);
    }

    const run = runFor(runAccount).finally(() => {
      inflightRef.current = null;

      if (againRef.current) {
        againRef.current = false;
        void syncNow();
      }
    });

    inflightRef.current = run;
    return run;
  }, [runFor]);

  // Sign-in (or another account), once the cookbook is loaded.
  useEffect(() => {
    unavailableUntilRef.current = 0;

    if (!account) {
      setStatus({ account: null, held: 0, lastSyncedAt: null, phase: "off" });
      return;
    }

    if (hasLoaded) {
      void syncNow();
    }
  }, [account, hasLoaded, syncNow]);

  // Changes here.
  useEffect(() => {
    if (
      !account ||
      !hasLoaded ||
      (savedRecipes === syncedRecordsRef.current && collections === syncedCollectionsRef.current)
    ) {
      return;
    }

    const timer = setTimeout(() => void syncNow(), COOKBOOK_SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [account, collections, hasLoaded, savedRecipes, syncNow]);

  // Back in the foreground, and a slow poll while open.
  useEffect(() => {
    if (!account || !hasLoaded) {
      return;
    }

    let lastWakeAt = Date.now();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && Date.now() - lastWakeAt >= WAKE_THROTTLE_MS) {
        lastWakeAt = Date.now();
        void syncNow();
      }
    });
    const poll = setInterval(() => {
      if (AppState.currentState === "active" && !inflightRef.current) {
        void syncNow();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      subscription.remove();
      clearInterval(poll);
    };
  }, [account, hasLoaded, syncNow]);

  const countChangesNotSynced = useCallback(
    () => countMobileChangesNotSynced(cookbook.getRecords(), cookbook.getCollections()),
    [cookbook]
  );

  const switchToAccountCookbook = useCallback(async () => {
    const switchingFor = accountRef.current;

    if (!switchingFor) {
      return;
    }

    await inflightRef.current?.catch(() => undefined);

    if (accountRef.current === switchingFor) {
      await replaceMobileLibrary(switchingFor, cookbook);
      await syncNow();
    }
  }, [cookbook, syncNow]);

  // Another account's state never shows, even for the render before its effect resets it.
  const visible = status.account === account ? status : null;
  const value = useMemo<CookbookSyncValue>(
    () => ({
      countChangesNotSynced,
      held: visible?.held ?? 0,
      lastSyncedAt: visible?.lastSyncedAt ?? null,
      phase: visible?.phase ?? "off",
      switchToAccountCookbook,
      syncNow
    }),
    [countChangesNotSynced, switchToAccountCookbook, syncNow, visible]
  );

  return <CookbookSyncContext.Provider value={value}>{children}</CookbookSyncContext.Provider>;
};

export const useCookbookSync = (): CookbookSyncValue => {
  const value = useContext(CookbookSyncContext);

  if (!value) {
    throw new Error("useCookbookSync must be used within SavedRecipesProvider.");
  }

  return value;
};
