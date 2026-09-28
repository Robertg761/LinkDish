import React, { useMemo, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { createCollection, useCollections } from "../../data/collections-store";
import { addToCollection, removeFromCollection, useSavedRecipes } from "../../data/library-store";

import {
  countRecipesByCollection,
  formatRecipeCount,
  getCollectionErrorMessage,
  getMembershipState
} from "./collection-helpers";
import { CollectionForm } from "./CollectionForm";

import "./CollectionsSheets.css";

export interface CollectionPickerSheetProps {
  open: boolean;
  onClose: () => void;
  /** The recipes to add or remove (one from a recipe page, several from a selection). */
  recipeIds: readonly string[];
}

/**
 * "Add to collection": tick collections on or off for one or more recipes, or create a new
 * collection inline (the recipes are added to it straight away). Changes save as you tap.
 */
export const CollectionPickerSheet: React.FC<CollectionPickerSheetProps> = ({
  open,
  onClose,
  recipeIds
}) => {
  const { collections, status } = useCollections();
  const { recipes } = useSavedRecipes();
  const { showToast } = useToast();
  const [creating, setCreating] = useState(false);
  const recipesById = useMemo(
    () => new Map(recipes.map((recipe) => [recipe.id, recipe])),
    [recipes]
  );
  const counts = useMemo(() => countRecipesByCollection(recipes), [recipes]);
  const targetIds = useMemo(
    () => recipeIds.filter((id) => recipesById.has(id)),
    [recipeIds, recipesById]
  );
  const singleTitle =
    targetIds.length === 1 ? recipesById.get(targetIds[0] ?? "")?.recipe.title : undefined;
  const showForm = creating || (status === "ready" && collections.length === 0);

  const setMembership = async (collectionId: string, add: boolean) => {
    try {
      await Promise.all(
        targetIds.map((id) =>
          add ? addToCollection(id, collectionId) : removeFromCollection(id, collectionId)
        )
      );
    } catch {
      showToast({
        message: "That collection couldn't be updated. Please try again.",
        tone: "danger"
      });
    }
  };

  const handleCreate = async (input: { name: string; emoji?: string | undefined }) => {
    const collection = await createCollection(input).catch((error: unknown) => {
      throw new Error(getCollectionErrorMessage(error, "That collection couldn't be created."), {
        cause: error
      });
    });

    await setMembership(collection.id, true);
    setCreating(false);
    showToast({
      icon: "folder",
      message:
        targetIds.length === 1
          ? `Added to ${collection.emoji ? `${collection.emoji} ` : ""}${collection.name}`
          : `Added ${targetIds.length} recipes to ${collection.name}`,
      tone: "success"
    });
  };

  return (
    <Sheet
      className="collection-sheet"
      description={
        singleTitle ? (
          <>
            Choose where <strong>{singleTitle}</strong> belongs.
          </>
        ) : targetIds.length > 1 ? (
          `Choose collections for ${targetIds.length} recipes.`
        ) : undefined
      }
      footer={
        <Button onClick={onClose} variant="primary">
          Done
        </Button>
      }
      onClose={onClose}
      open={open}
      size="sm"
      testId="collection-picker-sheet"
      title="Add to collection"
    >
      {collections.length > 0 ? (
        <ul aria-label="Collections" className="collection-list">
          {collections.map((collection) => {
            const state = getMembershipState(recipesById, targetIds, collection.id);
            const count = counts.get(collection.id) ?? 0;

            return (
              <li key={collection.id}>
                <button
                  aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
                  className={`collection-option${state !== "none" ? " is-selected" : ""}`}
                  onClick={() => {
                    void setMembership(collection.id, state !== "all");
                  }}
                  role="checkbox"
                  type="button"
                >
                  <span aria-hidden="true" className="collection-emoji-tile">
                    {collection.emoji ?? <Icon name="folder" size={18} />}
                  </span>
                  <span className="collection-option-copy">
                    <span className="collection-option-name">{collection.name}</span>
                    <span className="collection-option-count num">{formatRecipeCount(count)}</span>
                  </span>
                  <span aria-hidden="true" className="collection-check">
                    {state === "all" ? (
                      <Icon name="check" size={16} strokeWidth={2.6} />
                    ) : state === "some" ? (
                      <Icon name="minus" size={16} strokeWidth={2.6} />
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : status === "ready" ? (
        <p className="collection-sheet-hint">
          Collections group recipes your way: weeknight dinners, holiday baking, the ones worth a
          second go.
        </p>
      ) : null}

      {showForm ? (
        <CollectionForm
          onCancel={collections.length > 0 ? () => setCreating(false) : undefined}
          onSubmit={handleCreate}
          submitLabel={targetIds.length ? "Create and add" : "Create"}
        />
      ) : (
        <button className="collection-new" onClick={() => setCreating(true)} type="button">
          <span aria-hidden="true" className="collection-emoji-tile collection-new-tile">
            <Icon name="plus" size={18} />
          </span>
          New collection
        </button>
      )}
    </Sheet>
  );
};
