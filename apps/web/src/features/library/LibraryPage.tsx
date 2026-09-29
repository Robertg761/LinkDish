import React, {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { apiClient } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { getAccountScope, useIsCurrentAccount } from "../../auth/account-scope";
import { useAuth } from "../../auth/AuthProvider";
import { ErrorState } from "../../components/ErrorState";
import { PageHeader } from "../../components/PageHeader";
import { RecipeCard } from "../../components/RecipeCard";
import { SearchField } from "../../components/SearchField";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useToast } from "../../components/Toast";
import { loadCollections, useCollections } from "../../data/collections-store";
import {
  duplicateRecipe,
  loadSavedRecipes,
  removeSavedRecipe,
  toggleFavorite,
  useSavedRecipes
} from "../../data/library-store";
import { retryLinkDishStorage } from "../../data/storage-status";
import { useMediaQuery } from "../../lib/use-media-query";
import { holdAutoApplyUpdate, UNDO_UPDATE_HOLD_MS } from "../../platform/app-update";
import { afterNextPaint, useBootSettleHold } from "../../platform/boot-settle";
import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";
import { getWebBillingTier } from "../billing/web-billing";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import { FamilyLockedPanel } from "./components/FamilyLockedPanel";
import { describeFreeQuota, formatCookbookCount } from "./components/free-quota";
import {
  buildFilterChips,
  buildFilterPredicate,
  buildShelves,
  countCookbook,
  getLibrarySessionState,
  isStarterRecipe,
  QUICK_FILTER,
  readStoredSort,
  readStoredSortDirection,
  readStoredView,
  setLibrarySessionState,
  sortPersonalRecipes,
  storeSort,
  storeSortDirection,
  storeView
} from "./components/library-model";
import {
  AddToPlanSheet,
  CollectionPickerSheet,
  FamilySignInSheet,
  LazyConfirmationDialog,
  LazySheet,
  LibraryShoppingSheet,
  ManageCollectionsSheet,
  preloadRecipeMenuSheets,
  primeShoppingAccount,
  TagEditorSheet
} from "./components/library-sheets";
import { LibraryFilterBar } from "./components/LibraryFilterBar";
import { LibraryStorageBanner } from "./components/LibraryNotice";
import { LibraryQuotaMeter } from "./components/LibraryQuotaMeter";
import { LibraryRecipeTile } from "./components/LibraryRecipeTile";
import {
  LibraryNoResults,
  LibraryResultsHeading,
  LibrarySkeleton,
  LibraryToolbar,
  pluralize
} from "./components/LibraryResultsParts";
import { LIBRARY_SHELF_CARD_SIZES, LibraryShelf } from "./components/LibraryShelf";
import { LibraryWelcome, loadWelcomeSamples } from "./components/LibraryWelcome";
import { CompactRecipeMeta } from "./components/RecipeMeta";
import {
  recipeSearchKey,
  searchRecords,
  useRecipeSearchIndex,
  useSearchEngine
} from "./components/use-library-search";
import { isSharedRecipeNotFoundError, useSharedRecipes } from "./components/use-shared-recipes";
import {
  hasSeededStarterRecipes,
  LOCAL_LIMIT_FREE,
  restoreSavedRecipe,
  SavedRecipeLimitError,
  syncRecipeToHousehold
} from "./saved-recipe-store";

import type { TextHighlighter } from "./components/HighlightedText";
import type {
  LibraryFilterKey,
  LibrarySort,
  LibrarySortDirection,
  LibraryTab,
  LibraryView
} from "./components/library-model";
import type { LibraryRecipeAction } from "./components/LibraryRecipeTile";
import type { SearchIndexBuilder } from "./components/use-library-search";
import type { WebSavedRecipe } from "./saved-recipe-types";
import type { UpgradeSheetTrigger } from "../upgrade/UpgradeSheet";
import type { RecipeSearchFields } from "@linkdish/recipe-domain";

import "./LibraryPage.css";

/**
 * Photos fetched first (and shown without a fade): the grid's opening rows (two on a phone), or
 * the first shelf's first cards when shelves lead the page. Fewer of them arrive sooner.
 */
const PRIORITY_CARD_COUNT = 4;
const PRIORITY_SHELF_CARD_COUNT = 3;
/** Keeps the subtitle's line while the count is unknown, so nothing jumps when it arrives. */
const BLANK_SUBTITLE = "\u00a0";

/**
 * What the Cookbook reads before its first meaningful paint, requested from main.tsx alongside
 * this chunk (see app/routes.ts): the recipes and the collections (read together, so the filter
 * chips appear complete rather than growing a frame later), and on a first visit the welcome's
 * sample recipes.
 */
export const warmCookbook = (): Promise<void> => {
  if (!hasSeededStarterRecipes()) {
    loadWelcomeSamples().catch(() => undefined);
  }

  void loadCollections();
  return loadSavedRecipes();
};

// The Family tab is the minority of visits, so its UI loads on demand. (The welcome, a new cook's
// first paint, is part of this chunk: it must not wait for another download.)
const FamilyCookbook = lazyWithRetry(() =>
  import("./components/FamilyCookbook").then((module) => ({ default: module.FamilyCookbook }))
);

const getPersonalId = (recipe: WebSavedRecipe) => recipe.id;
/** Text only: a favorite or a re-read from storage must not rebuild the index. */
const getPersonalSignature = (recipe: WebSavedRecipe): readonly unknown[] => [
  recipeSearchKey(recipe.recipe),
  recipe.notes,
  recipe.tags?.join("\u0001"),
  recipe.collectionIds?.join("\u0001")
];
const getPersonalFallbackText = (recipe: WebSavedRecipe): string =>
  [
    recipe.recipe.title,
    ...(recipe.tags ?? []),
    ...recipe.recipe.ingredients.map((ingredient) => ingredient.text)
  ].join(" ");

/** Text fields and open menus (whose type-ahead owns printable keys) keep "/" for themselves. */
const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    /^(input|textarea|select)$/i.test(target.tagName) ||
    target.closest("[role='menu']") !== null);

interface ShoppingSheetState {
  /** The account the sheet was opened for: its household decides where the items go. */
  account: string | null;
  recipe: WebSavedRecipe;
  /** Undefined until the household check answers (the sheet then uses the cached mode). */
  canSync: boolean | undefined;
}

export const LibraryPage: React.FC = () => {
  const navigate = useNavigate();
  const { credentialsKey, isAuthenticated, loading: authLoading, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const { showToast } = useToast();
  const library = useSavedRecipes();
  const { collections } = useCollections();
  const shared = useSharedRecipes(isAuthenticated, user?.id, credentialsKey);
  const account = getAccountScope(isAuthenticated, user);
  const isCurrentAccount = useIsCurrentAccount(account);
  const showShortcutHint = useMediaQuery("(hover: hover) and (pointer: fine)");
  const compactSearch = useMediaQuery("(max-width: 479px)");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchStuck, setSearchStuck] = useState(false);
  const [initialSession] = useState(getLibrarySessionState);

  const [tab, setTab] = useState<LibraryTab>(initialSession.tab);
  const [query, setQuery] = useState(initialSession.query);
  const [filters, setFilters] = useState<LibraryFilterKey[]>(initialSession.filters);
  const [sort, setSort] = useState<LibrarySort>(readStoredSort);
  const [direction, setDirection] = useState<LibrarySortDirection>(readStoredSortDirection);
  const [view, setView] = useState<LibraryView>(readStoredView);
  // A first visit (starter recipes not seeded yet) always opens on the welcome. It shows while
  // storage is still being set up rather than after: from the frame after the first one (the
  // shell and this header, which paint as early as they can), above a skeleton of the recipes.
  const [expectingWelcome] = useState(() => !hasSeededStarterRecipes());
  const [welcomeAhead, setWelcomeAhead] = useState(false);

  const [familySignInOpen, setFamilySignInOpen] = useState(false);
  const [collectionPickerIds, setCollectionPickerIds] = useState<string[] | null>(null);
  const [manageCollectionsOpen, setManageCollectionsOpen] = useState(false);
  const [tagEditorId, setTagEditorId] = useState<string | null>(null);
  const [planRecipe, setPlanRecipe] = useState<WebSavedRecipe | null>(null);
  const [shoppingSheetState, setShoppingSheet] = useState<ShoppingSheetState | null>(null);
  /** A "Delete everywhere" confirmation, with the account it was opened for. */
  const [syncedDeleteAsk, setSyncedDeleteAsk] = useState<{
    account: string | null;
    recipe: WebSavedRecipe;
  } | null>(null);
  const [deletingSynced, setDeletingSynced] = useState(false);

  // A shopping sheet belongs to the account it was opened for (its household decides where the
  // items go): another account signing in or out never sees it, not even for a render, and it is
  // closed for good.
  const shoppingSheet = shoppingSheetState?.account === account ? shoppingSheetState : null;
  // Likewise a "Delete everywhere" confirmation: removing the household copy was that account's.
  const pendingSyncedDelete = syncedDeleteAsk?.account === account ? syncedDeleteAsk.recipe : null;
  const setPendingSyncedDelete = useCallback(
    (recipe: WebSavedRecipe | null) => setSyncedDeleteAsk(recipe ? { account, recipe } : null),
    [account]
  );

  useEffect(() => {
    setShoppingSheet((current) => (current && current.account !== account ? null : current));
    setSyncedDeleteAsk((current) => (current && current.account !== account ? null : current));
  }, [account]);

  const deferredQuery = useDeferredValue(query);
  const searchText = deferredQuery.trim();
  const searching = searchText.length > 0;
  const engine = useSearchEngine(query.trim().length > 0);
  const recipes = library.recipes;
  const billingTier = getWebBillingTier(user);
  const isPremiumUser = isAuthenticated ? billingTier !== "free" : undefined;
  const canUseSharedRecipeBook = isAuthenticated && !shared.accessBlocked;
  const familyTabLocked = !canUseSharedRecipeBook;
  // Signed-in cooks can open a locked Family tab: it explains Family instead of refusing the tap.
  const activeTab: LibraryTab = isAuthenticated ? tab : "personal";
  const isPersonal = activeTab === "personal";
  const familyLocked = !isPersonal && familyTabLocked;
  const libraryReady = library.status === "ready";
  const isEmptyLibrary = libraryReady && recipes.length === 0;
  const isNewCook = libraryReady && recipes.length > 0 && recipes.every(isStarterRecipe);

  // Deferred boot work (platform/boot-settle.ts) waits until the recipes (or the welcome) show.
  useBootSettleHold(library.status === "loading");

  const awaitingWelcome = expectingWelcome && library.status === "loading";

  useEffect(
    () =>
      awaitingWelcome && !welcomeAhead ? afterNextPaint(() => setWelcomeAhead(true)) : undefined,
    [awaitingWelcome, welcomeAhead]
  );

  // Remember search, filters and tab for the trip to a recipe and back.
  useEffect(() => {
    setLibrarySessionState({ filters, query, tab });
  }, [filters, query, tab]);

  // Signed out: drop back to Personal.
  useEffect(() => {
    if (!isAuthenticated && tab === "family") {
      setTab("personal");
    }
  }, [isAuthenticated, tab]);

  /* ------------------------------ Keyboard ------------------------------ */
  // "/" (outside text fields) jumps to search. ⌘K / Ctrl+K opens the command palette (the
  // CommandCenter claims it first); focusing search is only the fallback when it is absent.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const isSlash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      const isFind = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";

      if ((!isSlash && !isFind) || (isSlash && isTypingTarget(event.target))) {
        return;
      }

      const input = searchInputRef.current;

      if (!input || document.querySelector("[aria-modal='true']")) {
        return;
      }

      event.preventDefault();
      input.focus();
      input.select();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /* ------------------------------- Search ------------------------------- */
  // The sticky search bar turns opaque with a hairline once it is stuck, so cards scrolling under
  // it are covered cleanly instead of being sliced by a fade.
  const searchSentinelRef = useCallback((sentinel: HTMLDivElement | null) => {
    if (!sentinel || typeof IntersectionObserver === "undefined") {
      return undefined;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setSearchStuck(Boolean(entry && !entry.isIntersecting && entry.boundingClientRect.top < 0));
    });
    observer.observe(sentinel);

    return () => {
      observer.disconnect();
      setSearchStuck(false);
    };
  }, []);

  const collectionNames = useMemo(
    () => new Map(collections.map((collection) => [collection.id, collection.name])),
    [collections]
  );
  const collectionKey = useMemo(
    () => collections.map((collection) => `${collection.id}:${collection.name}`).join("|"),
    [collections]
  );
  const getPersonalFields = useCallback(
    (searchEngine: SearchIndexBuilder, recipe: WebSavedRecipe): RecipeSearchFields =>
      searchEngine.recipeSearchFields(recipe.recipe, {
        notes: recipe.notes,
        // Collection names count as tags, so "weeknight" finds the Weeknight collection too.
        tags: [
          ...(recipe.tags ?? []),
          ...(recipe.collectionIds ?? []).flatMap((id) => collectionNames.get(id) ?? [])
        ]
      }),
    [collectionNames]
  );
  const personalSearch = useRecipeSearchIndex(engine, recipes, {
    cacheKey: "personal",
    extraKey: collectionKey,
    getFields: getPersonalFields,
    getId: getPersonalId,
    getSignature: getPersonalSignature
  });
  const highlight = useMemo<TextHighlighter | undefined>(
    () => (engine && searching ? (text) => engine.highlightRanges(text, deferredQuery) : undefined),
    [deferredQuery, engine, searching]
  );

  const filterPredicate = useMemo(() => buildFilterPredicate(filters), [filters]);

  const visiblePersonal = useMemo(() => {
    if (searching) {
      return searchRecords(
        personalSearch,
        searchText,
        getPersonalFallbackText,
        filterPredicate ?? undefined
      );
    }

    const filtered = filterPredicate ? recipes.filter(filterPredicate) : recipes;
    return sortPersonalRecipes(filtered, sort, direction);
  }, [direction, filterPredicate, personalSearch, recipes, searchText, searching, sort]);

  /** Matches for the query with the filters ignored ("Show 3 matches without filters"). */
  const unfilteredMatchCount = useMemo(
    () =>
      searching && filters.length > 0 && visiblePersonal.length === 0
        ? searchRecords(personalSearch, searchText, getPersonalFallbackText).length
        : 0,
    [filters.length, personalSearch, searchText, searching, visiblePersonal.length]
  );

  // The filter bar shows with the search bar only (not on the welcome, for instance).
  const personalSearchShown = libraryReady && recipes.length > 0 && !isNewCook;
  const filterChips = useMemo(
    () => (isPersonal && personalSearchShown ? buildFilterChips(recipes, collections) : []),
    [collections, isPersonal, personalSearchShown, recipes]
  );
  const shelves = useMemo(
    () =>
      isPersonal && !searching && filters.length === 0 && !isNewCook
        ? buildShelves(recipes, sort)
        : [],
    [filters.length, isNewCook, isPersonal, recipes, searching, sort]
  );

  /* ------------------------------ Upgrades ------------------------------ */
  const offerUpgrade = useCallback(
    (trigger: UpgradeSheetTrigger) => {
      if (requestUpgradeSheet(trigger)) {
        return;
      }

      if (trigger === "save_limit") {
        showToast({
          action: { label: "See plans", onClick: () => void navigate("/pricing?upgrade=plus") },
          icon: "lock",
          id: "library-save-limit",
          message: `Free cookbooks hold ${LOCAL_LIMIT_FREE} recipes. Plus makes it unlimited.`
        });
      }
    },
    [navigate, requestUpgradeSheet, showToast]
  );
  const offerSaveLimitUpgrade = useCallback(() => offerUpgrade("save_limit"), [offerUpgrade]);

  /* --------------------------- Recipe actions --------------------------- */
  /**
   * Local recipes delete instantly; Undo writes the full record (and any scans) back, exactly as
   * the delete removed them (read in the deleting transaction).
   */
  const deleteWithUndo = async (recipe: WebSavedRecipe) => {
    let restorable: WebSavedRecipe | undefined;

    try {
      restorable = await removeSavedRecipe(recipe.id);
    } catch (error) {
      console.error("Delete failed:", error);
      showToast({ message: "This recipe could not be deleted. Please try again.", tone: "danger" });
      return;
    }

    if (restorable) {
      // Undo lives in memory: a waiting app update must not reload the page on the next tap.
      holdAutoApplyUpdate(UNDO_UPDATE_HOLD_MS);
    }

    showToast({
      action: restorable
        ? {
            label: "Undo",
            onClick: () => {
              restoreSavedRecipe(restorable, { isPremiumUser }).then(
                ({ recipe: current, restored }) => {
                  if (!restored) {
                    // Saved again (say, in another tab) since the delete: that newer copy stays.
                    showToast({
                      id: `library-delete-${recipe.id}`,
                      message: `“${current.recipe.title}” is already back in your cookbook.`
                    });
                  }
                },
                (error: unknown) => {
                  if (error instanceof SavedRecipeLimitError) {
                    // The cookbook filled up again since the delete: it stays deleted.
                    showToast({
                      action: {
                        label: "Upgrade",
                        onClick: () => {
                          if (!requestUpgradeSheet("save_limit")) {
                            void navigate("/pricing?upgrade=plus");
                          }
                        }
                      },
                      icon: "lock",
                      id: `library-delete-${recipe.id}`,
                      message: `Your cookbook is full, so “${recipe.recipe.title}” stays deleted. Free cookbooks hold ${LOCAL_LIMIT_FREE} recipes.`
                    });
                    return;
                  }

                  console.error("Restore failed:", error);
                  showToast({ message: getFriendlyErrorMessage(error, "save"), tone: "danger" });
                }
              );
            }
          }
        : undefined,
      icon: "trash",
      id: `library-delete-${recipe.id}`,
      message: `Deleted “${recipe.recipe.title}”`
    });
  };

  /** Household-synced recipes: remove the household copy first, then the local one. */
  const confirmSyncedDelete = async () => {
    const recipe = pendingSyncedDelete;
    const sharedRecipeId = recipe?.sync?.sharedRecipeId;

    if (!recipe || !sharedRecipeId) {
      setPendingSyncedDelete(null);
      return;
    }

    setDeletingSynced(true);

    try {
      try {
        await apiClient.deleteSharedRecipe(sharedRecipeId);
      } catch (error) {
        if (!isSharedRecipeNotFoundError(error)) {
          console.error("Could not delete from server:", error);
          showToast({
            message: "This recipe could not be deleted from your household. Please try again.",
            tone: "danger"
          });
          return;
        }
      }

      shared.removeLocal(sharedRecipeId);
      // No Undo here (the household copy is already gone), so nothing to read back.
      await removeSavedRecipe(recipe.id, { snapshot: false });
      setPendingSyncedDelete(null);
      showToast({
        icon: "trash",
        message: `Deleted “${recipe.recipe.title}” here and from your Family cookbook`
      });
    } catch (error) {
      console.error("Delete failed:", error);
      showToast({ message: "This recipe could not be removed. Please try again.", tone: "danger" });
    } finally {
      setDeletingSynced(false);
    }
  };

  const duplicate = async (recipe: WebSavedRecipe) => {
    try {
      const copy = await duplicateRecipe(recipe.id, { isPremiumUser });

      if (!copy) {
        showToast({ message: "This recipe could not be duplicated.", tone: "danger" });
        return;
      }

      showToast({ icon: "copy", message: `Saved “${copy.recipe.title}”`, tone: "success" });
      void navigate(`/recipes/${copy.id}`);
    } catch (error) {
      if (error instanceof SavedRecipeLimitError) {
        offerUpgrade("save_limit");
        return;
      }

      console.error("Duplicate failed:", error);
      showToast({ message: getFriendlyErrorMessage(error, "save"), tone: "danger" });
    }
  };

  const shareToFamily = async (recipe: WebSavedRecipe) => {
    if (!isAuthenticated) {
      setFamilySignInOpen(true);
      return;
    }

    const sharedFor = account;
    const wasShared = Boolean(recipe.sync?.sharedRecipeId);

    try {
      const synced = await syncRecipeToHousehold(recipe);

      // Another account signed in (or out) meanwhile: the recipe on this device records the
      // share, but its toast, or an upsell, was the last account's.
      if (!isCurrentAccount(sharedFor)) {
        return;
      }

      if (synced.sync?.status === "local_only") {
        requestUpgradeSheet("family_share_no_plan");
        return;
      }

      if (synced.sync?.status !== "synced") {
        showToast({ message: getFriendlyErrorMessage(null, "sync"), tone: "danger" });
        return;
      }

      if (!wasShared) {
        trackWebEvent({
          eventName: "family_shared",
          properties: { recipe_count: 1, share_scope: "household" },
          routeOrScreen: "/"
        });
      }

      showToast({
        icon: "users",
        message: wasShared ? "Family copy updated" : "Shared with your Family cookbook",
        tone: "success"
      });
      void shared.reload();
    } catch (error) {
      console.error("Sync failed:", error);

      if (isCurrentAccount(sharedFor)) {
        showToast({ message: getFriendlyErrorMessage(error, "sync"), tone: "danger" });
      }
    }
  };

  const openShopping = (recipe: WebSavedRecipe) => {
    const openedFor = account;
    // Not "false" while the household check is out (or when it fails): items added then would
    // stay on this device for good. Unknown falls back to the shopping sync layer's mode.
    setShoppingSheet({ account: openedFor, canSync: undefined, recipe });
    primeShoppingAccount({ isAuthenticated, loading: authLoading, userId: user?.id });

    if (isAuthenticated) {
      apiClient
        .getHousehold()
        .then((response) => {
          // Another account signed in meanwhile: the answer was the last one's household, and
          // must not decide where the next one's items go (even on a sheet it opened since).
          if (!isCurrentAccount(openedFor)) {
            return;
          }

          setShoppingSheet((current) =>
            current?.account === openedFor && current.recipe.id === recipe.id
              ? { ...current, canSync: Boolean(response.household) }
              : current
          );
        })
        .catch(() => undefined);
    }
  };

  const handleRecipeAction = (action: LibraryRecipeAction, recipe: WebSavedRecipe) => {
    switch (action) {
      case "collections":
        setCollectionPickerIds([recipe.id]);
        return;
      case "tags":
        setTagEditorId(recipe.id);
        return;
      case "plan":
        setPlanRecipe(recipe);
        return;
      case "shopping":
        openShopping(recipe);
        return;
      case "family":
        void shareToFamily(recipe);
        return;
      case "duplicate":
        void duplicate(recipe);
        return;
      case "delete":
        if (isAuthenticated && recipe.sync?.sharedRecipeId) {
          setPendingSyncedDelete(recipe);
        } else {
          void deleteWithUndo(recipe);
        }
        return;
      default:
        return;
    }
  };

  // Cards are memoized, so they get stable callbacks that always run the latest handlers.
  const handlersRef = useRef({ handleRecipeAction, showToast });
  handlersRef.current = { handleRecipeAction, showToast };
  const onRecipeAction = useCallback((action: LibraryRecipeAction, recipe: WebSavedRecipe) => {
    handlersRef.current.handleRecipeAction(action, recipe);
  }, []);
  const onToggleFavorite = useCallback((recipe: WebSavedRecipe) => {
    toggleFavorite(recipe.id).catch((error: unknown) => {
      console.error("Favorite failed:", error);
      handlersRef.current.showToast({
        message: "Favorites couldn't be updated. Please try again.",
        tone: "danger"
      });
    });
  }, []);

  /* ------------------------------ Controls ------------------------------ */
  const changeTab = (next: LibraryTab) => {
    if (next === "family" && !isAuthenticated) {
      setFamilySignInOpen(true);
      return;
    }

    setTab(next);
  };

  const toggleFilter = useCallback((key: LibraryFilterKey) => {
    setFilters((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
    );
  }, []);
  const clearFilters = useCallback(() => setFilters([]), []);
  const clearSearch = useCallback(() => setQuery(""), []);
  const openManageCollections = useCallback(() => setManageCollectionsOpen(true), []);

  const chooseSort = useCallback((next: LibrarySort) => {
    setSort(next);
    storeSort(next);
  }, []);

  const toggleDirection = useCallback(() => {
    setDirection((current) => {
      const next = current === "forward" ? "reverse" : "forward";
      storeSortDirection(next);
      return next;
    });
  }, []);

  const chooseView = useCallback((next: LibraryView) => {
    setView(next);
    storeView(next);
  }, []);

  /* ------------------------------- Render ------------------------------- */
  const cookbookCounts = countCookbook(recipes);
  const quota = describeFreeQuota(cookbookCounts, LOCAL_LIMIT_FREE);
  const showQuota =
    isPersonal && libraryReady && billingTier === "free" && quota.saved > 0 && !searching;
  const quotaNearlyFull = quota.state !== "roomy";
  const quotaMeter = showQuota ? (
    <LibraryQuotaMeter
      onUpgrade={() => {
        if (!requestUpgradeSheet("save_limit")) {
          void navigate("/pricing?upgrade=plus");
        }
      }}
      quota={quota}
    />
  ) : null;

  const subtitle = isPersonal
    ? libraryReady
      ? formatCookbookCount(cookbookCounts)
      : BLANK_SUBTITLE
    : familyLocked
      ? "Not set up yet"
      : shared.status === "ready"
        ? pluralize(shared.recipes.length, "family recipe")
        : BLANK_SUBTITLE;
  const showSearch = isPersonal ? personalSearchShown : !familyLocked;
  const showWelcome =
    isPersonal && (isEmptyLibrary || isNewCook || (awaitingWelcome && welcomeAhead));
  const showFilters = isPersonal && showSearch && filterChips.length > 0;

  const renderPersonal = () => {
    if (library.status === "error") {
      return (
        <ErrorState
          message={`${getFriendlyErrorMessage(library.error, "load")} Your recipes are kept in this browser, so nothing has been lost.`}
          onRetry={() => {
            void retryLinkDishStorage().then(() => library.retry());
          }}
          title="We couldn't open your cookbook"
        />
      );
    }

    if (!libraryReady) {
      // Nothing yet in the first frame of a first visit: the welcome comes next, above this.
      return awaitingWelcome && !welcomeAhead ? null : <LibrarySkeleton view={view} />;
    }

    if (isEmptyLibrary) {
      return null;
    }

    return (
      <>
        {shelves.map((shelf, shelfIndex) => (
          <LibraryShelf
            action={
              shelf.id === "quick"
                ? {
                    ariaLabel: "Show all quick recipes",
                    label: "See all",
                    onClick: () => setFilters([QUICK_FILTER])
                  }
                : shelf.id === "cook-again"
                  ? {
                      ariaLabel: "Sort all recipes by recently cooked",
                      label: "See all",
                      onClick: () => chooseSort("recentlyCooked")
                    }
                  : undefined
            }
            icon={shelf.id === "cook-again" ? "rotate-ccw" : shelf.id === "quick" ? "zap" : "clock"}
            key={shelf.id}
            title={shelf.title}
          >
            {shelf.recipes.map((recipe, index) => (
              <li key={recipe.id}>
                <RecipeCard
                  className="library-shelf-card"
                  imageSizes={LIBRARY_SHELF_CARD_SIZES}
                  image={recipe.recipe.image}
                  meta={<CompactRecipeMeta recipe={recipe.recipe} />}
                  priority={shelfIndex === 0 && index < PRIORITY_SHELF_CARD_COUNT}
                  title={recipe.recipe.title}
                  to={`/recipes/${recipe.id}`}
                />
              </li>
            ))}
          </LibraryShelf>
        ))}
        <section aria-label="Recipes" className="library-results">
          <LibraryToolbar
            availableSorts={null}
            direction={direction}
            heading={
              <LibraryResultsHeading
                filtered={filters.length > 0}
                searchText={searchText}
                title={isNewCook ? "Starter recipes" : "All recipes"}
                totalCount={recipes.length}
                visibleCount={visiblePersonal.length}
              />
            }
            onDirectionToggle={toggleDirection}
            onSortChange={chooseSort}
            onViewChange={chooseView}
            showSort={!searching}
            sort={sort}
            view={view}
          />
          {visiblePersonal.length === 0 ? (
            <LibraryNoResults
              filterCount={filters.length}
              onClearFilters={clearFilters}
              onClearSearch={clearSearch}
              searchText={searchText}
              unfilteredMatchCount={unfilteredMatchCount}
            />
          ) : (
            <ul className={`library-${view}`}>
              {visiblePersonal.map((recipe, index) => (
                <li className="library-item" key={recipe.id}>
                  <LibraryRecipeTile
                    canShareToFamily={canUseSharedRecipeBook}
                    highlight={highlight}
                    onAction={onRecipeAction}
                    onMenuOpen={preloadRecipeMenuSheets}
                    onToggleFavorite={onToggleFavorite}
                    priority={shelves.length === 0 && index < PRIORITY_CARD_COUNT}
                    recipe={recipe}
                    view={view}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </>
    );
  };

  const tabOptions = [
    { label: "Personal", value: "personal" as const },
    {
      // Always an icon, so the control keeps its width when the lock state resolves.
      icon: familyTabLocked ? ("lock" as const) : ("users" as const),
      label: "Family",
      value: "family" as const
    }
  ];

  return (
    <div className="library-page container-wide page-enter">
      <div className="library-content">
        <PageHeader
          actions={
            <SegmentedControl
              aria-label="Cookbook"
              onChange={changeTab}
              options={tabOptions}
              size="sm"
              value={activeTab}
            />
          }
          className="library-header"
          subtitle={<span className="num">{subtitle}</span>}
          title="Cookbook"
        />

        <LibraryStorageBanner />

        {showWelcome ? (
          // The welcome comes first and the starter recipes below it (a skeleton while a first
          // visit sets up storage), so the welcome card never lands on top of cards already on
          // screen.
          <>
            <LibraryWelcome variant={isEmptyLibrary ? "empty" : "starter"} />
            {renderPersonal()}
          </>
        ) : null}

        {showSearch ? (
          <>
            <div aria-hidden="true" className="library-search-sentinel" ref={searchSentinelRef} />
            <div className={`library-search-bar${searchStuck ? " is-stuck" : ""}`}>
              <SearchField
                aria-label="Search your cookbook"
                inputRef={searchInputRef}
                onValueChange={setQuery}
                placeholder={
                  isPersonal
                    ? compactSearch
                      ? "Search recipes"
                      : "Search recipes, ingredients, tags"
                    : compactSearch
                      ? "Search family recipes"
                      : "Search family recipes and cooks"
                }
                shortcutHint={showShortcutHint ? "/" : undefined}
                size="lg"
                value={query}
              />
            </div>
          </>
        ) : null}

        {showFilters ? (
          <LibraryFilterBar
            chips={filterChips}
            hasCollections={collections.length > 0}
            onClear={clearFilters}
            onManageCollections={openManageCollections}
            onToggle={toggleFilter}
            selected={filters}
          />
        ) : null}

        {quotaNearlyFull ? quotaMeter : null}

        {showWelcome ? null : isPersonal ? (
          renderPersonal()
        ) : familyLocked ? (
          <FamilyLockedPanel tier={billingTier} />
        ) : (
          <OptionalChunkBoundary name="Family cookbook">
            <Suspense fallback={<LibrarySkeleton view={view} />}>
              <FamilyCookbook
                account={account}
                direction={direction}
                engine={engine}
                highlight={highlight}
                isCurrentAccount={isCurrentAccount}
                isPremiumUser={isPremiumUser}
                // Keyed by account: a confirmation opened for one account's family recipe
                // never stays open for the next.
                key={account ?? "signed-out"}
                onClearSearch={clearSearch}
                onDirectionToggle={toggleDirection}
                onSaveLimit={offerSaveLimitUpgrade}
                onSortChange={chooseSort}
                onViewChange={chooseView}
                searchText={searchText}
                shared={shared}
                sort={sort}
                userId={user?.id}
                view={view}
              />
            </Suspense>
          </OptionalChunkBoundary>
        )}

        {!quotaNearlyFull ? quotaMeter : null}
      </div>

      {familySignInOpen ? (
        <LazySheet name="Family sign-in" onError={() => setFamilySignInOpen(false)}>
          <FamilySignInSheet onClose={() => setFamilySignInOpen(false)} open />
        </LazySheet>
      ) : null}

      {collectionPickerIds ? (
        <LazySheet name="Collection picker" onError={() => setCollectionPickerIds(null)}>
          <CollectionPickerSheet
            onClose={() => setCollectionPickerIds(null)}
            open
            recipeIds={collectionPickerIds}
          />
        </LazySheet>
      ) : null}

      {manageCollectionsOpen ? (
        <LazySheet name="Collections" onError={() => setManageCollectionsOpen(false)}>
          <ManageCollectionsSheet onClose={() => setManageCollectionsOpen(false)} open />
        </LazySheet>
      ) : null}

      {tagEditorId ? (
        <LazySheet name="Tag editor" onError={() => setTagEditorId(null)}>
          <TagEditorSheet onClose={() => setTagEditorId(null)} open recipeId={tagEditorId} />
        </LazySheet>
      ) : null}

      {planRecipe ? (
        <LazySheet name="Add to plan" onError={() => setPlanRecipe(null)}>
          <AddToPlanSheet
            analyticsSource="cookbook"
            onClose={() => setPlanRecipe(null)}
            open
            recipeId={planRecipe.id}
            recipeTitle={planRecipe.recipe.title}
          />
        </LazySheet>
      ) : null}

      {shoppingSheet ? (
        <LibraryShoppingSheet
          canSync={shoppingSheet.canSync}
          onAdded={(count) => {
            showToast({
              action: { label: "View list", onClick: () => void navigate("/shopping") },
              icon: "shopping-basket",
              message: `${pluralize(count, "item")} added to your ${
                shoppingSheet.canSync ? "household " : ""
              }shopping list`,
              tone: "success"
            });
          }}
          onClose={() => setShoppingSheet(null)}
          recipe={shoppingSheet.recipe}
          userId={user?.id}
        />
      ) : null}

      {pendingSyncedDelete ? (
        <LazySheet name="Delete confirmation" onError={() => setPendingSyncedDelete(null)}>
          <LazyConfirmationDialog
            cancelLabel="Keep recipe"
            confirmLabel="Delete everywhere"
            confirmLoading={deletingSynced}
            message={
              pendingSyncedDelete
                ? `“${pendingSyncedDelete.recipe.title}” is shared with your Family. Deleting it removes it from this device and from your Family cookbook.`
                : ""
            }
            onCancel={() => setPendingSyncedDelete(null)}
            onConfirm={() => {
              void confirmSyncedDelete();
            }}
            title="Delete shared recipe?"
            visible
          />
        </LazySheet>
      ) : null}
    </div>
  );
};
