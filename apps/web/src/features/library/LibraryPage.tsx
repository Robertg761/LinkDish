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
import { useAuth } from "../../auth/AuthProvider";
import { ButtonLink } from "../../components/Button";
import { ErrorState } from "../../components/ErrorState";
import { IconButton } from "../../components/IconButton";
import { PageHeader } from "../../components/PageHeader";
import { RecipeCard } from "../../components/RecipeCard";
import { SearchField } from "../../components/SearchField";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useToast } from "../../components/Toast";
import { useCollections } from "../../data/collections-store";
import {
  duplicateRecipe,
  removeSavedRecipe,
  toggleFavorite,
  useSavedRecipes
} from "../../data/library-store";
import { retryLinkDishStorage } from "../../data/storage-status";
import { useMediaQuery } from "../../lib/use-media-query";
import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";
import { getWebBillingTier } from "../billing/web-billing";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import {
  buildFilterChips,
  buildFilterPredicate,
  buildShelves,
  countQuotaRecipes,
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
  CollectionPickerSheet,
  FamilySignInSheet,
  LazyConfirmationDialog,
  LazySheet,
  LibraryShoppingSheet,
  ManageCollectionsSheet,
  preloadRecipeMenuSheets,
  TagEditorSheet
} from "./components/library-sheets";
import { LibraryFilterBar } from "./components/LibraryFilterBar";
import { LibraryNotice, LibraryStorageBanner } from "./components/LibraryNotice";
import { LibraryQuotaMeter, QUOTA_NEARLY_FULL_AT } from "./components/LibraryQuotaMeter";
import { LibraryRecipeTile } from "./components/LibraryRecipeTile";
import {
  LibraryNoResults,
  LibraryResultsHeading,
  LibrarySkeleton,
  LibraryToolbar,
  pluralize
} from "./components/LibraryResultsParts";
import { LibraryShelf } from "./components/LibraryShelf";
import { CompactRecipeMeta } from "./components/RecipeMeta";
import {
  searchRecords,
  useRecipeSearchIndex,
  useSearchEngine
} from "./components/use-library-search";
import {
  FAMILY_ACCESS_MESSAGE,
  isSharedRecipeNotFoundError,
  useSharedRecipes
} from "./components/use-shared-recipes";
import {
  getSavedRecipeById,
  LOCAL_LIMIT_FREE,
  putSavedRecipe,
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
import type { SearchEngine } from "./components/use-library-search";
import type { WebSavedRecipe } from "./saved-recipe-types";
import type { UpgradeSheetTrigger } from "../upgrade/UpgradeSheet";
import type { RecipeSearchFields } from "@linkdish/recipe-domain";

import "./LibraryPage.css";

const PRIORITY_CARD_COUNT = 6;
/** Keeps the subtitle's line while the count is unknown, so nothing jumps when it arrives. */
const BLANK_SUBTITLE = "\u00a0";

// New cooks and the Family tab are the minority of visits, so their UI loads on demand.
const LibraryWelcome = lazyWithRetry(() =>
  import("./components/LibraryWelcome").then((module) => ({ default: module.LibraryWelcome }))
);
const FamilyCookbook = lazyWithRetry(() =>
  import("./components/FamilyCookbook").then((module) => ({ default: module.FamilyCookbook }))
);

const getPersonalId = (recipe: WebSavedRecipe) => recipe.id;
const getPersonalSignature = (recipe: WebSavedRecipe): readonly unknown[] => [
  recipe.recipe,
  recipe.notes,
  recipe.tags,
  recipe.collectionIds
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

const isMacLike = (): boolean => {
  try {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  } catch {
    return false;
  }
};

interface ShoppingSheetState {
  recipe: WebSavedRecipe;
  canSync: boolean;
}

export const LibraryPage: React.FC = () => {
  const navigate = useNavigate();
  const { credentialsKey, isAuthenticated, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const { showToast } = useToast();
  const library = useSavedRecipes();
  const { collections } = useCollections();
  const shared = useSharedRecipes(isAuthenticated, user?.id, credentialsKey);
  const showShortcutHint = useMediaQuery("(hover: hover) and (pointer: fine)");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [initialSession] = useState(getLibrarySessionState);

  const [tab, setTab] = useState<LibraryTab>(initialSession.tab);
  const [query, setQuery] = useState(initialSession.query);
  const [filters, setFilters] = useState<LibraryFilterKey[]>(initialSession.filters);
  const [sort, setSort] = useState<LibrarySort>(readStoredSort);
  const [direction, setDirection] = useState<LibrarySortDirection>(readStoredSortDirection);
  const [view, setView] = useState<LibraryView>(readStoredView);

  const [familyExplainerVisible, setFamilyExplainerVisible] = useState(false);
  const [familySignInOpen, setFamilySignInOpen] = useState(false);
  const [collectionPickerIds, setCollectionPickerIds] = useState<string[] | null>(null);
  const [manageCollectionsOpen, setManageCollectionsOpen] = useState(false);
  const [tagEditorId, setTagEditorId] = useState<string | null>(null);
  const [shoppingSheet, setShoppingSheet] = useState<ShoppingSheetState | null>(null);
  const [pendingSyncedDelete, setPendingSyncedDelete] = useState<WebSavedRecipe | null>(null);
  const [deletingSynced, setDeletingSynced] = useState(false);

  const deferredQuery = useDeferredValue(query);
  const searchText = deferredQuery.trim();
  const searching = searchText.length > 0;
  const engine = useSearchEngine(query.trim().length > 0);
  const recipes = library.recipes;
  const billingTier = getWebBillingTier(user);
  const isPremiumUser = isAuthenticated ? billingTier !== "free" : undefined;
  const canUseSharedRecipeBook = isAuthenticated && !shared.accessBlocked;
  const familyTabLocked = !canUseSharedRecipeBook;
  const activeTab: LibraryTab = familyTabLocked ? "personal" : tab;
  const isPersonal = activeTab === "personal";
  const libraryReady = library.status === "ready";
  const isEmptyLibrary = libraryReady && recipes.length === 0;
  const isNewCook = libraryReady && recipes.length > 0 && recipes.every(isStarterRecipe);

  // Remember search, filters and tab for the trip to a recipe and back.
  useEffect(() => {
    setLibrarySessionState({ filters, query, tab });
  }, [filters, query, tab]);

  // Signed out, or Family became unavailable: drop back to Personal.
  useEffect(() => {
    if (familyTabLocked && tab === "family") {
      setTab("personal");
    }
  }, [familyTabLocked, tab]);

  /* ------------------------------ Keyboard ------------------------------ */
  // "/" (outside text fields) and ⌘K / Ctrl+K jump to search.
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
  const collectionNames = useMemo(
    () => new Map(collections.map((collection) => [collection.id, collection.name])),
    [collections]
  );
  const collectionKey = useMemo(
    () => collections.map((collection) => `${collection.id}:${collection.name}`).join("|"),
    [collections]
  );
  const getPersonalFields = useCallback(
    (searchEngine: SearchEngine, recipe: WebSavedRecipe): RecipeSearchFields =>
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

  const filterChips = useMemo(() => buildFilterChips(recipes, collections), [collections, recipes]);
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
  /** Local recipes delete instantly; Undo writes the full record (and any scans) back. */
  const deleteWithUndo = async (recipe: WebSavedRecipe) => {
    let snapshot: WebSavedRecipe | undefined;

    try {
      snapshot = await getSavedRecipeById(recipe.id);
    } catch {
      snapshot = undefined;
    }

    try {
      await removeSavedRecipe(recipe.id);
    } catch (error) {
      console.error("Delete failed:", error);
      showToast({ message: "This recipe could not be deleted. Please try again.", tone: "danger" });
      return;
    }

    const restorable = snapshot;
    showToast({
      action: restorable
        ? {
            label: "Undo",
            onClick: () => {
              putSavedRecipe(restorable).catch((error: unknown) => {
                console.error("Restore failed:", error);
                showToast({ message: getFriendlyErrorMessage(error, "save"), tone: "danger" });
              });
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
      await removeSavedRecipe(recipe.id);
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

    const wasShared = Boolean(recipe.sync?.sharedRecipeId);

    try {
      const synced = await syncRecipeToHousehold(recipe);

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
      showToast({ message: getFriendlyErrorMessage(error, "sync"), tone: "danger" });
    }
  };

  const openShopping = (recipe: WebSavedRecipe) => {
    setShoppingSheet({ canSync: false, recipe });

    if (isAuthenticated) {
      apiClient
        .getHousehold()
        .then((response) => {
          setShoppingSheet((current) =>
            current?.recipe.id === recipe.id
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
    if (next === "family" && familyTabLocked) {
      setFamilyExplainerVisible(true);
      setFamilySignInOpen(!isAuthenticated);
      return;
    }

    setFamilyExplainerVisible(false);
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
  const quotaCount = countQuotaRecipes(recipes);
  const showQuota =
    isPersonal && libraryReady && billingTier === "free" && quotaCount > 0 && !searching;
  const quotaNearlyFull = quotaCount >= QUOTA_NEARLY_FULL_AT;
  const quotaMeter = showQuota ? (
    <LibraryQuotaMeter
      count={quotaCount}
      limit={LOCAL_LIMIT_FREE}
      onUpgrade={() => {
        if (!requestUpgradeSheet("save_limit")) {
          void navigate("/pricing?upgrade=plus");
        }
      }}
    />
  ) : null;

  const subtitle = isPersonal
    ? libraryReady
      ? recipes.length
        ? pluralize(recipes.length, "recipe")
        : "No recipes yet"
      : BLANK_SUBTITLE
    : shared.status === "ready"
      ? pluralize(shared.recipes.length, "family recipe")
      : BLANK_SUBTITLE;
  const showSearch = isPersonal ? libraryReady && recipes.length > 0 && !isNewCook : true;
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
      return <LibrarySkeleton view={view} />;
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
                  image={recipe.recipe.image}
                  meta={<CompactRecipeMeta recipe={recipe.recipe} />}
                  priority={shelfIndex === 0 && index < 3}
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
      icon: familyTabLocked ? ("lock" as const) : undefined,
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

        {familyExplainerVisible ? (
          <LibraryNotice
            actions={
              <>
                {isAuthenticated ? (
                  <ButtonLink
                    className="library-notice-link"
                    size="sm"
                    to="/household"
                    variant="secondary"
                  >
                    Set up Family
                  </ButtonLink>
                ) : (
                  <button
                    className="library-notice-button"
                    onClick={() => setFamilySignInOpen(true)}
                    type="button"
                  >
                    Sign in to use Family
                  </button>
                )}
                <IconButton
                  aria-label="Dismiss"
                  icon="x"
                  onClick={() => setFamilyExplainerVisible(false)}
                  size="sm"
                />
              </>
            }
            icon="lock"
          >
            {isAuthenticated
              ? (shared.error ?? FAMILY_ACCESS_MESSAGE)
              : "Sign in to create or join an active Family household."}
          </LibraryNotice>
        ) : null}

        {isPersonal && (isEmptyLibrary || isNewCook) ? (
          <OptionalChunkBoundary name="Welcome">
            <Suspense fallback={<div className="library-welcome-placeholder" />}>
              <LibraryWelcome variant={isEmptyLibrary ? "empty" : "starter"} />
            </Suspense>
          </OptionalChunkBoundary>
        ) : null}

        {showSearch ? (
          <div className="library-search-bar">
            <SearchField
              aria-label="Search your cookbook"
              inputRef={searchInputRef}
              onValueChange={setQuery}
              placeholder={
                isPersonal ? "Search recipes, ingredients, tags" : "Search family recipes and cooks"
              }
              shortcutHint={showShortcutHint ? (isMacLike() ? "⌘K" : "Ctrl K") : undefined}
              size="lg"
              value={query}
            />
          </div>
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

        {isPersonal ? (
          renderPersonal()
        ) : (
          <OptionalChunkBoundary name="Family cookbook">
            <Suspense fallback={<LibrarySkeleton view={view} />}>
              <FamilyCookbook
                direction={direction}
                engine={engine}
                highlight={highlight}
                isPremiumUser={isPremiumUser}
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
