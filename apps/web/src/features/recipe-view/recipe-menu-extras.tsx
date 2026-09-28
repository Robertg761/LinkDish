import React, { Suspense, useMemo, useState } from "react";

import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";

import type { MenuEntry } from "../../components/Menu";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

/*
 * The organisation sheets load only when a cook opens one, so the recipe page does not ship the
 * collections, tags or planner code up front.
 */
const CollectionPickerSheet = lazyWithRetry(() =>
  import("../collections/CollectionPickerSheet").then((module) => ({
    default: module.CollectionPickerSheet
  }))
);
const TagEditorSheet = lazyWithRetry(() =>
  import("../collections/TagEditorSheet").then((module) => ({
    default: module.TagEditorSheet
  }))
);
const AddToPlanSheet = lazyWithRetry(() =>
  import("../plan/AddToPlanSheet").then((module) => ({ default: module.AddToPlanSheet }))
);

/**
 * Extension point for the recipe overflow menu. Features that own their own sheets (collections,
 * tags, meal plan…) add menu entries here and render their sheets through `elements`; the recipe
 * page places the entries between "Print" and "Delete" and mounts the elements once.
 */
export interface RecipeMenuExtras {
  items: readonly MenuEntry[];
  elements: React.ReactNode;
}

type OpenSheet = "collections" | "tags" | "plan" | null;

/**
 * `recipe` is the saved recipe on screen (null on household-shared routes, where personal
 * organisation does not apply).
 */
export const useRecipeMenuExtras = (recipe: WebSavedRecipe | null): RecipeMenuExtras => {
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  const recipeId = recipe?.id ?? null;
  const recipeTitle = recipe?.recipe.title ?? "";
  const preferredServings = recipe?.preferredServings;

  const items = useMemo<readonly MenuEntry[]>(() => {
    if (!recipeId) {
      return [];
    }

    return [
      {
        icon: "calendar-plus",
        id: "add-to-plan",
        label: "Add to meal plan…",
        onSelect: () => setOpenSheet("plan")
      },
      {
        icon: "folder-plus",
        id: "add-to-collection",
        label: "Add to collection…",
        onSelect: () => setOpenSheet("collections")
      },
      {
        icon: "tags",
        id: "edit-tags",
        label: "Edit tags…",
        onSelect: () => setOpenSheet("tags")
      }
    ];
  }, [recipeId]);

  const close = () => setOpenSheet(null);

  const elements =
    recipeId && openSheet ? (
      <OptionalChunkBoundary key={openSheet} name="Recipe organiser" onError={close}>
        <Suspense fallback={null}>
          {openSheet === "collections" ? (
            <CollectionPickerSheet onClose={close} open recipeIds={[recipeId]} />
          ) : null}
          {openSheet === "tags" ? (
            <TagEditorSheet onClose={close} open recipeId={recipeId} />
          ) : null}
          {openSheet === "plan" ? (
            <AddToPlanSheet
              defaultServings={preferredServings}
              onClose={close}
              open
              recipeId={recipeId}
              recipeTitle={recipeTitle}
            />
          ) : null}
        </Suspense>
      </OptionalChunkBoundary>
    ) : null;

  return { elements, items };
};
