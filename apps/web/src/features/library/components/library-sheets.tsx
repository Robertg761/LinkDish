import React, { Suspense } from "react";

import { lazyWithRetry } from "../../../platform/lazy";
import { OptionalChunkBoundary } from "../../../platform/OptionalChunkBoundary";

import type { WebSavedRecipe } from "../saved-recipe-types";

/*
 * The Cookbook is the entry route, so its sheets load on demand: nobody pays for the collection
 * editor, tag editor or shopping sheet (which pulls in cook mode's scaling code) until they open
 * one. Opening an overflow menu warms the likely ones.
 */

export const CollectionPickerSheet = lazyWithRetry(() =>
  import("../../collections/CollectionPickerSheet").then((module) => ({
    default: module.CollectionPickerSheet
  }))
);

export const ManageCollectionsSheet = lazyWithRetry(() =>
  import("../../collections/ManageCollectionsSheet").then((module) => ({
    default: module.ManageCollectionsSheet
  }))
);

export const TagEditorSheet = lazyWithRetry(() =>
  import("../../collections/TagEditorSheet").then((module) => ({
    default: module.TagEditorSheet
  }))
);

export const AddToPlanSheet = lazyWithRetry(() =>
  import("../../plan/AddToPlanSheet").then((module) => ({ default: module.AddToPlanSheet }))
);

export const FamilySignInSheet = lazyWithRetry(() =>
  import("./FamilySignInSheet").then((module) => ({ default: module.FamilySignInSheet }))
);

export const LazyConfirmationDialog = lazyWithRetry(() =>
  import("../../../components/ConfirmationDialog").then((module) => ({
    default: module.ConfirmationDialog
  }))
);

const AddRecipeToShoppingSheet = lazyWithRetry(() =>
  import("../../shopping/AddRecipeToShoppingSheet").then((module) => ({
    default: module.AddRecipeToShoppingSheet
  }))
);

export const preloadRecipeMenuSheets = (): void => {
  void CollectionPickerSheet.preload().catch(() => undefined);
  void TagEditorSheet.preload().catch(() => undefined);
};

/** Wraps an optional lazy sheet so a chunk failure closes it instead of breaking the page. */
export const LazySheet: React.FC<{
  name: string;
  onError: () => void;
  children: React.ReactNode;
}> = ({ name, onError, children }) => (
  <OptionalChunkBoundary name={name} onError={onError}>
    <Suspense fallback={null}>{children}</Suspense>
  </OptionalChunkBoundary>
);

/** The shopping sheet at the recipe's own size (1×, original units). */
const LIBRARY_SHOPPING_SCALING = {
  customFactor: "1",
  factor: 1,
  unitPreference: "primary" as const
};

interface LibraryShoppingSheetProps {
  recipe: WebSavedRecipe;
  canSync: boolean;
  userId?: string | undefined;
  onAdded: (count: number) => void;
  onClose: () => void;
}

export const LibraryShoppingSheet: React.FC<LibraryShoppingSheetProps> = ({
  recipe,
  canSync,
  userId,
  onAdded,
  onClose
}) => (
  <LazySheet name="Shopping sheet" onError={onClose}>
    <AddRecipeToShoppingSheet
      canSync={canSync}
      onAdded={onAdded}
      onClose={onClose}
      recipe={recipe.recipe}
      recipeId={recipe.id}
      scaling={LIBRARY_SHOPPING_SCALING}
      userId={userId}
    />
  </LazySheet>
);
