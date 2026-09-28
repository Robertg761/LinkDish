import React, { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { apiClient } from "../../../api/client";
import { ConfirmationDialog } from "../../../components/ConfirmationDialog";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { useToast } from "../../../components/Toast";
import {
  getSharedRecipeOwnerLabel,
  SavedRecipeLimitError,
  saveSharedRecipeCopy
} from "../saved-recipe-store";

import { FAMILY_SORTS, sortSharedRecipes } from "./library-model";
import {
  LibraryNoResults,
  LibraryResultsHeading,
  LibrarySkeleton,
  LibraryToolbar
} from "./LibraryResultsParts";
import { SharedRecipeTile } from "./SharedRecipeTile";
import { recipeSearchKey, searchRecords, useRecipeSearchIndex } from "./use-library-search";

import type { TextHighlighter } from "./HighlightedText";
import type { LibrarySort, LibrarySortDirection, LibraryView } from "./library-model";
import type { SharedRecipeAction } from "./SharedRecipeTile";
import type { SearchEngine, SearchIndexBuilder } from "./use-library-search";
import type { SharedRecipesState } from "./use-shared-recipes";
import type { SharedRecipe } from "@linkdish/api-contracts";
import type { RecipeSearchFields } from "@linkdish/recipe-domain";

const PRIORITY_CARD_COUNT = 6;

const getId = (recipe: SharedRecipe) => recipe.id;
const getSignature = (recipe: SharedRecipe): readonly unknown[] => [
  recipeSearchKey(recipe.recipe),
  recipe.notes,
  recipe.ownerDisplayName
];
const getFields = (engine: SearchIndexBuilder, recipe: SharedRecipe): RecipeSearchFields => {
  const fields = engine.recipeSearchFields(recipe.recipe, { notes: recipe.notes });
  const source = [fields.source, getSharedRecipeOwnerLabel(recipe)]
    .flat()
    .filter((value): value is string => typeof value === "string");
  return { ...fields, source };
};
const getFallbackText = (recipe: SharedRecipe) =>
  [recipe.recipe.title, getSharedRecipeOwnerLabel(recipe)].join(" ");

export interface FamilyCookbookProps {
  shared: SharedRecipesState;
  engine: SearchEngine | null;
  /** The (deferred) search text, trimmed. */
  searchText: string;
  highlight?: TextHighlighter | undefined;
  sort: LibrarySort;
  direction: LibrarySortDirection;
  view: LibraryView;
  userId?: string | undefined;
  isPremiumUser?: boolean | undefined;
  onSortChange: (sort: LibrarySort) => void;
  onDirectionToggle: () => void;
  onViewChange: (view: LibraryView) => void;
  onClearSearch: () => void;
  onSaveLimit: () => void;
}

/**
 * The Family tab: recipes shared with the household, with who added each one. Loaded on demand,
 * since most visits never open it.
 */
export const FamilyCookbook: React.FC<FamilyCookbookProps> = ({
  shared,
  engine,
  searchText,
  highlight,
  sort,
  direction,
  view,
  userId,
  isPremiumUser,
  onSortChange,
  onDirectionToggle,
  onViewChange,
  onClearSearch,
  onSaveLimit
}) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [pendingUnshare, setPendingUnshare] = useState<SharedRecipe | null>(null);
  const [removing, setRemoving] = useState(false);
  const effectiveSort = FAMILY_SORTS.has(sort) ? sort : "recent";
  const search = useRecipeSearchIndex(engine, shared.recipes, {
    cacheKey: "family",
    getFields,
    getId,
    getSignature
  });

  const visible = useMemo(
    () =>
      searchText
        ? searchRecords(search, searchText, getFallbackText)
        : sortSharedRecipes(shared.recipes, effectiveSort, direction),
    [direction, effectiveSort, search, searchText, shared.recipes]
  );

  const saveCopy = async (recipe: SharedRecipe) => {
    try {
      const copy = await saveSharedRecipeCopy(recipe, { isPremiumUser });
      showToast({
        action: { label: "Open", onClick: () => void navigate(`/recipes/${copy.id}`) },
        icon: "copy",
        message: `Saved “${copy.recipe.title}” to Personal`,
        tone: "success"
      });
    } catch (error) {
      if (error instanceof SavedRecipeLimitError) {
        onSaveLimit();
        return;
      }

      console.error("Save copy failed:", error);
      showToast({
        message: "This family recipe could not be saved as a personal copy.",
        tone: "danger"
      });
    }
  };

  const confirmUnshare = async () => {
    const recipe = pendingUnshare;

    if (!recipe) {
      return;
    }

    setRemoving(true);

    try {
      await apiClient.deleteSharedRecipe(recipe.id);
      shared.removeLocal(recipe.id);
      setPendingUnshare(null);
      showToast({ icon: "users", message: "Removed from your Family cookbook" });
    } catch (error) {
      console.error("Unshare failed:", error);
      showToast({ message: "This family recipe could not be removed.", tone: "danger" });
    } finally {
      setRemoving(false);
    }
  };

  const handlersRef = useRef({ saveCopy, setPendingUnshare });
  handlersRef.current = { saveCopy, setPendingUnshare };
  const onAction = useCallback((action: SharedRecipeAction, recipe: SharedRecipe) => {
    if (action === "save-copy") {
      void handlersRef.current.saveCopy(recipe);
    } else {
      handlersRef.current.setPendingUnshare(recipe);
    }
  }, []);

  let content: React.ReactNode;

  if (shared.status === "loading" || shared.status === "idle") {
    content = <LibrarySkeleton view={view} />;
  } else if (shared.status === "error") {
    content = (
      <ErrorState
        message={shared.error ?? "Family recipes could not be loaded."}
        onRetry={() => {
          void shared.reload();
        }}
        title="Family recipes are out of reach"
      />
    );
  } else if (shared.recipes.length === 0) {
    content = (
      <EmptyState
        body="Share a recipe from Personal with More → Share to Family, and everyone in your household can cook from it."
        illustration="cookbook"
        title="Your Family cookbook is empty"
      />
    );
  } else {
    content = (
      <section aria-label="Family recipes" className="library-results">
        <LibraryToolbar
          availableSorts={FAMILY_SORTS}
          direction={direction}
          heading={
            <LibraryResultsHeading
              filtered={false}
              searchText={searchText}
              title="Family recipes"
              totalCount={shared.recipes.length}
              visibleCount={visible.length}
            />
          }
          onDirectionToggle={onDirectionToggle}
          onSortChange={onSortChange}
          onViewChange={onViewChange}
          showSort={!searchText}
          sort={effectiveSort}
          view={view}
        />
        {visible.length === 0 ? (
          <LibraryNoResults
            filterCount={0}
            onClearFilters={onClearSearch}
            onClearSearch={onClearSearch}
            searchText={searchText}
            unfilteredMatchCount={0}
          />
        ) : (
          <ul className={`library-${view}`}>
            {visible.map((recipe, index) => (
              <li className="library-item" key={recipe.id}>
                <SharedRecipeTile
                  highlight={searchText ? highlight : undefined}
                  isOwner={recipe.ownerUserId === userId}
                  onAction={onAction}
                  priority={index < PRIORITY_CARD_COUNT}
                  recipe={recipe}
                  view={view}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <>
      {content}
      <ConfirmationDialog
        cancelLabel="Keep shared"
        confirmLabel="Remove"
        confirmLoading={removing}
        message={
          pendingUnshare
            ? `Remove “${pendingUnshare.recipe.title}” from your Family cookbook? Personal copies stay where they are.`
            : ""
        }
        onCancel={() => setPendingUnshare(null)}
        onConfirm={() => {
          void confirmUnshare();
        }}
        title="Remove from Family?"
        visible={Boolean(pendingUnshare)}
      />
    </>
  );
};
