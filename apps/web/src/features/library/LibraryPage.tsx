import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";

import { apiClient, ExtractorApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { EMPTY_LIBRARY_LINES, pickFlavorLine } from "../../lib/flavor-copy";
import { getRecipeMonogram } from "../../lib/recipe-image";
import { buildRecipeMetaLine } from "../recipes/recipe-meta";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import {
  deleteSavedRecipe,
  duplicateSavedRecipe,
  getSavedRecipes,
  getSharedRecipeOwnerLabel,
  saveSharedRecipeCopy,
  seedStarterRecipesIfNeeded,
  syncRecipeToHousehold
} from "./saved-recipe-store";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type { SharedRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

import "./LibraryPage.css";

type LibraryTab = "personal" | "family";
type LibrarySort = "recent" | "az" | "mostCooked";
type LibrarySortDirection = "forward" | "reverse";

const LIBRARY_SORT_STORAGE_KEY = "linkdish:web:cookbook-sort:v1";
const LIBRARY_SORT_DIRECTION_STORAGE_KEY = "linkdish:web:cookbook-sort-direction:v1";
const LIBRARY_SORT_OPTIONS: Array<{ label: string; value: LibrarySort }> = [
  { label: "Recent", value: "recent" },
  { label: "A-Z", value: "az" },
  { label: "Most cooked", value: "mostCooked" }
];

const getStoredLibrarySort = (): LibrarySort => {
  try {
    const storedSort = localStorage.getItem(LIBRARY_SORT_STORAGE_KEY);

    return storedSort === "az" || storedSort === "mostCooked" || storedSort === "recent"
      ? storedSort
      : "recent";
  } catch {
    return "recent";
  }
};

const getStoredLibrarySortDirection = (): LibrarySortDirection => {
  try {
    return localStorage.getItem(LIBRARY_SORT_DIRECTION_STORAGE_KEY) === "reverse"
      ? "reverse"
      : "forward";
  } catch {
    return "forward";
  }
};

const RECENT_TIEBREAKER = (left: { updatedAt: string }, right: { updatedAt: string }) =>
  new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();

const normalizeRecipeText = (value: string): string => value.replace(/\u00a0/gu, " ");

const getApiErrorMessage = (err: ExtractorApiError): string => {
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

const isSharedRecipeAccessError = (err: unknown): boolean => {
  if (!(err instanceof ExtractorApiError) || (err.statusCode !== 403 && err.statusCode !== 404)) {
    return false;
  }

  return /active LinkDish Family household|active household|households are not enabled/i.test(
    getApiErrorMessage(err)
  );
};

const isSharedRecipeNotFoundError = (err: unknown): boolean =>
  err instanceof ExtractorApiError && err.statusCode === 404;

const getRecipeSearchText = (
  recipe: Recipe,
  extraParts: Array<string | null | undefined> = []
): string =>
  [
    recipe.title,
    recipe.ingredients.map((ingredient) => ingredient.text).join(" "),
    recipe.steps.map((step) => step.text).join(" "),
    ...extraParts
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const applySortDirection = <T,>(items: T[], direction: LibrarySortDirection): T[] =>
  direction === "reverse" ? items.reverse() : items;

const sortPersonalRecipes = (
  recipes: WebSavedRecipe[],
  sort: LibrarySort,
  direction: LibrarySortDirection
): WebSavedRecipe[] => {
  const sorted = [...recipes];

  if (sort === "az") {
    return applySortDirection(
      sorted.sort((left, right) =>
        normalizeRecipeText(left.recipe.title).localeCompare(
          normalizeRecipeText(right.recipe.title)
        )
      ),
      direction
    );
  }

  if (sort === "mostCooked") {
    return applySortDirection(
      sorted.sort(
        (left, right) =>
          (right.timesCooked ?? 0) - (left.timesCooked ?? 0) || RECENT_TIEBREAKER(left, right)
      ),
      direction
    );
  }

  return applySortDirection(sorted.sort(RECENT_TIEBREAKER), direction);
};

const sortSharedRecipes = (
  recipes: SharedRecipe[],
  sort: Exclude<LibrarySort, "mostCooked">,
  direction: LibrarySortDirection
): SharedRecipe[] => {
  const sorted = [...recipes];

  if (sort === "az") {
    return applySortDirection(
      sorted.sort((left, right) =>
        normalizeRecipeText(left.recipe.title).localeCompare(
          normalizeRecipeText(right.recipe.title)
        )
      ),
      direction
    );
  }

  return applySortDirection(sorted.sort(RECENT_TIEBREAKER), direction);
};

const RecipeMonogramTile = ({ recipe }: { recipe: Pick<Recipe, "title"> }) => (
  <div className="recipe-row-monogram" aria-hidden="true">
    {getRecipeMonogram(recipe.title)}
  </div>
);

const IconAction = ({
  active = false,
  ariaLabel,
  disabled = false,
  icon,
  onClick
}: {
  active?: boolean;
  ariaLabel: string;
  disabled?: boolean;
  icon: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    aria-label={ariaLabel}
    className={`recipe-row-icon-action${active ? " is-active" : ""}`}
    disabled={disabled}
    onClick={onClick}
  >
    <Icon name={icon} size={19} />
  </button>
);

export const LibraryPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const [personalRecipes, setPersonalRecipes] = useState<WebSavedRecipe[]>([]);
  const [sharedRecipes, setSharedRecipes] = useState<SharedRecipe[]>([]);
  const [activeTab, setActiveTab] = useState<LibraryTab>("personal");
  const [sort, setSort] = useState<LibrarySort>(getStoredLibrarySort);
  const [sortDirection, setSortDirection] = useState<LibrarySortDirection>(
    getStoredLibrarySortDirection
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [savingCopyId, setSavingCopyId] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [sharedRecipeError, setSharedRecipeError] = useState<string | null>(null);
  const [sharedRecipeAccessBlocked, setSharedRecipeAccessBlocked] = useState(false);
  const [familyExplainerVisible, setFamilyExplainerVisible] = useState(false);
  const [familySignInPromptVisible, setFamilySignInPromptVisible] = useState(false);
  const [emptyLibraryTitle] = useState(() => pickFlavorLine(EMPTY_LIBRARY_LINES));
  const sortMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_SORT_STORAGE_KEY, sort);
    } catch {
      // Sorting remains usable when storage is unavailable.
    }
  }, [sort]);

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_SORT_DIRECTION_STORAGE_KEY, sortDirection);
    } catch {
      // Sorting remains usable when storage is unavailable.
    }
  }, [sortDirection]);

  useEffect(() => {
    if (!sortMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSortMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sortMenuOpen]);

  const loadRecipes = async () => {
    try {
      await seedStarterRecipesIfNeeded();
      setPersonalRecipes(await getSavedRecipes());

      if (isAuthenticated) {
        try {
          const response = await apiClient.getSharedRecipes();
          setSharedRecipes(response.recipes);
          setSharedRecipeError(null);
          setSharedRecipeAccessBlocked(false);
        } catch (err) {
          console.error("Failed to load shared recipes:", err);
          setSharedRecipes([]);
          setSharedRecipeAccessBlocked(isSharedRecipeAccessError(err));
          setSharedRecipeError(
            isSharedRecipeAccessError(err)
              ? "Family recipe sharing is available after you create or join an active Family household."
              : "Family recipes could not be loaded. Check your connection and try again."
          );
        }
      } else {
        setSharedRecipes([]);
        setSharedRecipeError(null);
        setSharedRecipeAccessBlocked(false);
      }
    } catch (err) {
      console.error("Failed to load recipes from IndexedDB:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void loadRecipes();
  }, [isAuthenticated]);

  useEffect(() => {
    if ((!isAuthenticated || sharedRecipeAccessBlocked) && activeTab === "family") {
      setActiveTab("personal");
    }
  }, [activeTab, isAuthenticated, sharedRecipeAccessBlocked]);

  const canUseSharedRecipeBook = isAuthenticated && !sharedRecipeAccessBlocked;
  const familyTabLocked = !canUseSharedRecipeBook;
  const familyExplainer =
    sharedRecipeError ??
    (isAuthenticated
      ? "Family recipe sharing is available after you create or join an active Family household."
      : "Sign in to create or join an active Family household.");

  const handleFamilyTabClick = () => {
    if (familyTabLocked) {
      setFamilyExplainerVisible(true);
      setActiveTab("personal");
      setFamilySignInPromptVisible(!isAuthenticated);
      return;
    }

    setFamilyExplainerVisible(false);
    setFamilySignInPromptVisible(false);
    setActiveTab("family");
  };

  const handleDelete = async (recipe: WebSavedRecipe) => {
    setActionMessage("");

    try {
      if (isAuthenticated && recipe.sync?.sharedRecipeId) {
        try {
          await apiClient.deleteSharedRecipe(recipe.sync.sharedRecipeId);
        } catch (serverErr) {
          if (!isSharedRecipeNotFoundError(serverErr)) {
            console.error("Could not delete from server:", serverErr);
            setActionMessage(
              "This recipe could not be deleted from your household. Please try again."
            );
            return;
          }
        }
      }

      await deleteSavedRecipe(recipe.id);
      setPendingRemoveId(null);
      setActionMessage("Recipe removed.");
      await loadRecipes();
    } catch (err) {
      console.error("Delete failed:", err);
      setActionMessage("This recipe could not be removed. Please try again.");
    }
  };

  const handleDuplicate = async (recipe: WebSavedRecipe) => {
    setActionMessage("");
    const duplicate = await duplicateSavedRecipe(recipe.id);

    if (!duplicate) {
      setActionMessage("This recipe could not be duplicated.");
      return;
    }

    void navigate(`/recipes/${duplicate.id}?edit=1`);
  };

  const handleSync = async (recipe: WebSavedRecipe) => {
    if (!isAuthenticated) {
      setFamilyExplainerVisible(true);
      return;
    }

    setSyncingId(recipe.id);
    setActionMessage("");
    try {
      const syncedRecipe = await syncRecipeToHousehold(recipe);
      if (syncedRecipe.sync?.status === "local_only") {
        requestUpgradeSheet("family_share_no_plan");
      }
      await loadRecipes();
    } catch (err) {
      console.error("Sync failed:", err);
      await loadRecipes();
    } finally {
      setSyncingId(null);
    }
  };

  const handleSaveSharedCopy = async (sharedRecipe: SharedRecipe) => {
    setSavingCopyId(sharedRecipe.id);
    setActionMessage("");

    try {
      const copy = await saveSharedRecipeCopy(sharedRecipe);
      setActionMessage(`Saved "${copy.recipe.title}" to your personal recipes.`);
      await loadRecipes();
    } catch (err) {
      console.error("Save copy failed:", err);
      setActionMessage("This family recipe could not be saved as a personal copy.");
    } finally {
      setSavingCopyId(null);
    }
  };

  const handleUnshare = async (sharedRecipe: SharedRecipe) => {
    setActionMessage("");

    try {
      await apiClient.deleteSharedRecipe(sharedRecipe.id);
      setPendingRemoveId(null);
      setActionMessage("Recipe removed from your family recipe book.");
      await loadRecipes();
    } catch (err) {
      console.error("Unshare failed:", err);
      setActionMessage("This family recipe could not be removed.");
    }
  };

  const query = search.trim().toLowerCase();
  const filteredPersonalRecipes = useMemo(() => {
    const filtered = query
      ? personalRecipes.filter((recipe) =>
          getRecipeSearchText(recipe.recipe, [recipe.notes, recipe.sourceHost]).includes(query)
        )
      : personalRecipes;

    return sortPersonalRecipes(filtered, sort, sortDirection);
  }, [personalRecipes, query, sort, sortDirection]);
  const filteredSharedRecipes = useMemo(() => {
    const filtered = query
      ? sharedRecipes.filter((recipe) =>
          getRecipeSearchText(recipe.recipe, [
            recipe.notes,
            getSharedRecipeOwnerLabel(recipe),
            recipe.recipe.sourceUrl
          ]).includes(query)
        )
      : sharedRecipes;

    return sortSharedRecipes(filtered, sort === "az" ? "az" : "recent", sortDirection);
  }, [query, sharedRecipes, sort, sortDirection]);
  const visiblePersonalRecipes = activeTab === "personal";
  const visibleSort = !visiblePersonalRecipes && sort === "mostCooked" ? "recent" : sort;
  const visibleSortLabel =
    LIBRARY_SORT_OPTIONS.find((option) => option.value === visibleSort)?.label ?? "Recent";
  const sortDirectionLabel =
    visibleSort === "recent"
      ? sortDirection === "forward"
        ? "Newest first"
        : "Oldest first"
      : visibleSort === "az"
        ? sortDirection === "forward"
          ? "A to Z"
          : "Z to A"
        : sortDirection === "forward"
          ? "Most cooked first"
          : "Least cooked first";
  const visibleSortOptions = visiblePersonalRecipes
    ? LIBRARY_SORT_OPTIONS
    : LIBRARY_SORT_OPTIONS.filter((option) => option.value !== "mostCooked");
  const visibleRecipesCount = visiblePersonalRecipes
    ? filteredPersonalRecipes.length
    : filteredSharedRecipes.length;
  const emptyStateTitle = search ? "No recipes match your search." : emptyLibraryTitle;
  const emptyStateSubtitle = search
    ? "Try another title, ingredient, method, note, or owner."
    : visiblePersonalRecipes
      ? "Import a recipe to start building your collection."
      : "Shared household recipes will appear here.";

  const renderPersonalRecipe = (recipe: WebSavedRecipe, index: number) => {
    const metaLine = buildRecipeMetaLine(recipe.recipe, {
      includeSourceType: false,
      servingsFallback: null
    });
    const isPendingRemove = pendingRemoveId === recipe.id;

    return (
      <article
        key={recipe.id}
        className="recipe-row"
        style={
          {
            "--library-row-delay": `${Math.min(index, 7) * 18}ms`
          } as React.CSSProperties & { "--library-row-delay": string }
        }
      >
        <Link
          to={`/recipes/${recipe.id}`}
          className="recipe-row-main"
          aria-label={recipe.recipe.title}
        >
          <RecipeMonogramTile recipe={recipe.recipe} />
          <div className="recipe-row-content">
            <h2 className="recipe-row-title">{normalizeRecipeText(recipe.recipe.title)}</h2>
            {metaLine ? <p className="recipe-row-meta">{metaLine}</p> : null}
            {recipe.notes ? (
              <p className="recipe-row-meta recipe-row-notes">
                {normalizeRecipeText(recipe.notes)}
              </p>
            ) : null}
            {recipe.isStarter ? <span className="starter-recipe-chip">Starter recipe</span> : null}
          </div>
        </Link>

        <div className="recipe-row-actions">
          <Link
            to={`/recipes/${recipe.id}`}
            className="recipe-row-open"
            aria-label={`Open ${recipe.recipe.title}`}
          >
            <Icon name="chevron-right" size={20} />
          </Link>
          <IconAction
            ariaLabel={`Duplicate ${recipe.recipe.title}`}
            icon="content-copy"
            onClick={() => {
              void handleDuplicate(recipe);
            }}
          />
          {isPendingRemove ? (
            <div
              className="recipe-row-confirm"
              role="group"
              aria-label={`Confirm remove ${recipe.recipe.title}`}
            >
              <button
                type="button"
                className="recipe-row-confirm-button"
                onClick={() => setPendingRemoveId(null)}
              >
                Keep
              </button>
              <button
                type="button"
                className="recipe-row-confirm-button is-danger"
                onClick={() => {
                  void handleDelete(recipe);
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <IconAction
              ariaLabel={`Remove ${recipe.recipe.title}`}
              icon="bookmark-remove-outline"
              onClick={() => setPendingRemoveId(recipe.id)}
            />
          )}
          {canUseSharedRecipeBook && !recipe.isStarter ? (
            <IconAction
              active={recipe.sync?.status === "synced"}
              ariaLabel={
                recipe.sync?.status === "synced"
                  ? `Synced ${recipe.recipe.title} to Family`
                  : `Share ${recipe.recipe.title} to Family`
              }
              disabled={syncingId === recipe.id}
              icon={
                recipe.sync?.status === "synced"
                  ? "account-multiple-check-outline"
                  : "account-multiple-plus-outline"
              }
              onClick={() => {
                void handleSync(recipe);
              }}
            />
          ) : null}
        </div>
      </article>
    );
  };

  const renderSharedRecipe = (sharedRecipe: SharedRecipe, index: number) => {
    const isOwner = sharedRecipe.ownerUserId === user?.id;
    const metaLine = buildRecipeMetaLine(sharedRecipe.recipe, {
      includeSourceType: false,
      servingsFallback: null
    });
    const isPendingRemove = pendingRemoveId === sharedRecipe.id;

    return (
      <article
        key={sharedRecipe.id}
        className="recipe-row"
        style={
          {
            "--library-row-delay": `${Math.min(index, 7) * 18}ms`
          } as React.CSSProperties & { "--library-row-delay": string }
        }
      >
        <Link
          to={`/recipes/shared/${sharedRecipe.id}`}
          className="recipe-row-main"
          aria-label={sharedRecipe.recipe.title}
        >
          <RecipeMonogramTile recipe={sharedRecipe.recipe} />
          <div className="recipe-row-content">
            <h2 className="recipe-row-title">{normalizeRecipeText(sharedRecipe.recipe.title)}</h2>
            {metaLine ? <p className="recipe-row-meta">{metaLine}</p> : null}
            <p className="recipe-row-meta">Owned by {getSharedRecipeOwnerLabel(sharedRecipe)}</p>
          </div>
        </Link>

        <div className="recipe-row-actions">
          <Link
            to={`/recipes/shared/${sharedRecipe.id}`}
            className="recipe-row-open"
            aria-label={`Open ${sharedRecipe.recipe.title}`}
          >
            <Icon name="chevron-right" size={20} />
          </Link>
          <IconAction
            ariaLabel={`Save copy of ${sharedRecipe.recipe.title}`}
            disabled={savingCopyId === sharedRecipe.id}
            icon="content-copy"
            onClick={() => {
              void handleSaveSharedCopy(sharedRecipe);
            }}
          />
          {isOwner && isPendingRemove ? (
            <div
              className="recipe-row-confirm"
              role="group"
              aria-label={`Confirm remove ${sharedRecipe.recipe.title} from Family`}
            >
              <button
                type="button"
                className="recipe-row-confirm-button"
                onClick={() => setPendingRemoveId(null)}
              >
                Keep
              </button>
              <button
                type="button"
                className="recipe-row-confirm-button is-danger"
                onClick={() => {
                  void handleUnshare(sharedRecipe);
                }}
              >
                Remove
              </button>
            </div>
          ) : isOwner ? (
            <IconAction
              ariaLabel={`Remove ${sharedRecipe.recipe.title} from Family`}
              icon="bookmark-remove-outline"
              onClick={() => setPendingRemoveId(sharedRecipe.id)}
            />
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <div className="library-page container-wide page-enter">
      <div className="library-content">
        <header className="library-header">
          <h1 className="library-title">Cookbook</h1>
        </header>

        <div className="library-controls">
          <div className="library-segment-row" role="tablist" aria-label="Recipe library sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "personal"}
              className={`library-segment ${activeTab === "personal" ? "is-active" : ""}`}
              onClick={() => {
                setFamilyExplainerVisible(false);
                setFamilySignInPromptVisible(false);
                setActiveTab("personal");
              }}
            >
              Personal
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "family"}
              aria-disabled={isAuthenticated ? familyTabLocked : undefined}
              className={`library-segment ${activeTab === "family" ? "is-active" : ""} ${
                familyTabLocked ? "is-locked" : ""
              }`}
              onClick={handleFamilyTabClick}
            >
              {familyTabLocked ? <Icon name="lock-outline" size={14} /> : null}
              Family
            </button>
          </div>

          <div className="library-utility-row">
            <label className="library-search" htmlFor="recipe-search">
              <Icon name="magnify" size={19} />
              <input
                id="recipe-search"
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, ingredients, method, notes"
              />
            </label>

            <div className="library-sort-row" role="group" aria-label="Recipe sort">
              <div className="library-sort-menu-wrap" ref={sortMenuRef}>
                <button
                  aria-expanded={sortMenuOpen}
                  aria-haspopup="menu"
                  aria-label={`Sort recipes. Current: ${visibleSortLabel}`}
                  className="library-sort-button"
                  onClick={() => setSortMenuOpen((open) => !open)}
                  type="button"
                >
                  <Icon name="sort" size={18} />
                  <span>{visibleSortLabel}</span>
                  <Icon name="chevron-down" size={17} />
                </button>
                {sortMenuOpen ? (
                  <div aria-label="Sort recipes" className="library-sort-menu" role="menu">
                    {visibleSortOptions.map((option) => (
                      <button
                        aria-checked={visibleSort === option.value}
                        className={`library-sort-option${
                          visibleSort === option.value ? " is-selected" : ""
                        }`}
                        key={option.value}
                        onClick={() => {
                          setSort(option.value);
                          setSortMenuOpen(false);
                        }}
                        role="menuitemradio"
                        type="button"
                      >
                        <span>{option.label}</span>
                        {visibleSort === option.value ? <Icon name="check" size={17} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                aria-label={`Order: ${sortDirectionLabel}. Reverse order`}
                className="library-sort-direction"
                onClick={() =>
                  setSortDirection((direction) => (direction === "forward" ? "reverse" : "forward"))
                }
                title={sortDirectionLabel}
                type="button"
              >
                <Icon name={sortDirection === "forward" ? "arrow-down" : "arrow-up"} size={19} />
              </button>
            </div>
          </div>
        </div>

        {(familyExplainerVisible || sharedRecipeError) && (
          <div className="library-family-explainer" role="status">
            <span>{familyExplainer}</span>
            {!isAuthenticated ? (
              <button
                type="button"
                className="library-family-explainer-action"
                onClick={() => setFamilySignInPromptVisible(true)}
              >
                Sign in to use Family
              </button>
            ) : null}
          </div>
        )}

        {actionMessage ? (
          <div className="library-action-message" role="status">
            {actionMessage}
          </div>
        ) : null}

        {loading ? (
          <p className="library-empty">Loading saved recipes...</p>
        ) : visibleRecipesCount === 0 ? (
          <div className="library-empty-card">
            <span className="library-empty-icon">
              <Icon
                name={
                  search
                    ? "magnify"
                    : visiblePersonalRecipes
                      ? "book-open-page-variant"
                      : "account-group-outline"
                }
                size={28}
                color="currentColor"
              />
            </span>
            <div className="library-empty-copy">
              <h2 className="library-empty-title">{emptyStateTitle}</h2>
              <p className="library-empty">{emptyStateSubtitle}</p>
            </div>
            {search ? (
              <button
                type="button"
                className="library-empty-button"
                onClick={() => {
                  setSearch("");
                }}
              >
                Clear search
              </button>
            ) : (
              <ButtonLink to="/import" variant="primary">
                Import a Recipe
              </ButtonLink>
            )}
          </div>
        ) : (
          <div className="recipes-list">
            {visiblePersonalRecipes
              ? filteredPersonalRecipes.map(renderPersonalRecipe)
              : filteredSharedRecipes.map(renderSharedRecipe)}
          </div>
        )}
      </div>

      {familySignInPromptVisible
        ? createPortal(
            <div className="library-sign-in-prompt-backdrop" role="presentation">
              <section
                aria-labelledby="library-sign-in-prompt-title"
                aria-modal="true"
                className="library-sign-in-prompt"
                role="dialog"
              >
                <div className="library-sign-in-prompt-header">
                  <div>
                    <p className="library-sign-in-prompt-eyebrow">Family cookbook</p>
                    <h2 id="library-sign-in-prompt-title">Cook together, in one place.</h2>
                  </div>
                  <button
                    type="button"
                    aria-label="Close Family sign-in prompt"
                    className="library-sign-in-prompt-close"
                    onClick={() => setFamilySignInPromptVisible(false)}
                  >
                    <Icon name="close" size={20} />
                  </button>
                </div>
                <p>
                  Sign in to create or join a LinkDish Family household and share recipes with the
                  people you cook with.
                </p>
                <div className="library-sign-in-prompt-actions">
                  <ButtonLink to="/account" variant="primary">
                    Sign in
                  </ButtonLink>
                  <Button variant="ghost" onClick={() => setFamilySignInPromptVisible(false)}>
                    Cancel
                  </Button>
                </div>
              </section>
            </div>,
            document.body
          )
        : null}
    </div>
  );
};
