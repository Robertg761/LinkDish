import React, { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import {
  createCollection,
  deleteCollection,
  reorderCollections,
  updateCollection,
  useCollections
} from "../../data/collections-store";
import { useSavedRecipes } from "../../data/library-store";

import {
  countRecipesByCollection,
  formatRecipeCount,
  getCollectionErrorMessage
} from "./collection-helpers";
import { CollectionForm } from "./CollectionForm";
import { EmojiChoices } from "./EmojiChoices";

import type { WebCollection } from "../../data/collections-store";

import "./CollectionsSheets.css";

export interface ManageCollectionsSheetProps {
  open: boolean;
  onClose: () => void;
}

interface CollectionRowProps {
  collection: WebCollection;
  count: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (collection: WebCollection, direction: -1 | 1) => void;
  onError: (message: string) => void;
}

const CollectionRow: React.FC<CollectionRowProps> = ({
  collection,
  count,
  isFirst,
  isLast,
  onMove,
  onError
}) => {
  const [name, setName] = useState(collection.name);
  const [pickingEmoji, setPickingEmoji] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(collection.name);
  }, [collection.name]);

  const commitName = async () => {
    const trimmed = name.trim();

    if (trimmed === collection.name) {
      return;
    }

    try {
      await updateCollection(collection.id, { name: trimmed });
    } catch (error) {
      setName(collection.name);
      onError(getCollectionErrorMessage(error, "That name couldn't be saved."));
    }
  };

  const changeEmoji = async (emoji: string | undefined) => {
    setPickingEmoji(false);

    try {
      await updateCollection(collection.id, { emoji: emoji ?? "" });
    } catch {
      onError("That emoji couldn't be saved.");
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);

    try {
      await deleteCollection(collection.id);
    } catch {
      setDeleting(false);
      onError("That collection couldn't be deleted. Please try again.");
    }
  };

  if (confirmingDelete) {
    return (
      <li className="collection-manage-row is-confirming">
        <div className="collection-confirm" role="group" aria-label={`Delete ${collection.name}`}>
          <p className="collection-confirm-text">
            Delete <strong>{collection.name}</strong>? Its {formatRecipeCount(count)} stay in your
            cookbook.
          </p>
          <div className="collection-confirm-actions">
            <Button onClick={() => setConfirmingDelete(false)} size="sm" variant="ghost">
              Keep
            </Button>
            <Button
              loading={deleting}
              onClick={() => {
                void confirmDelete();
              }}
              size="sm"
              variant="danger"
            >
              Delete
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="collection-manage-row">
      <div className="collection-manage-main">
        <button
          aria-expanded={pickingEmoji}
          aria-label={`Change emoji for ${collection.name}`}
          className="collection-emoji-tile collection-emoji-button"
          onClick={() => setPickingEmoji((current) => !current)}
          type="button"
        >
          {collection.emoji ?? <Icon name="folder" size={18} />}
        </button>
        <div className="collection-manage-name">
          <input
            aria-label={`Name of ${collection.name}`}
            className="collection-rename-input"
            onBlur={() => {
              void commitName();
            }}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                // Keep Escape for the input: revert instead of closing the sheet.
                event.stopPropagation();
                setName(collection.name);
              }
            }}
            value={name}
          />
          <span className="collection-option-count num">{formatRecipeCount(count)}</span>
        </div>
        <div className="collection-manage-tools">
          <IconButton
            aria-label={`Move ${collection.name} up`}
            disabled={isFirst}
            icon="chevron-up"
            onClick={() => onMove(collection, -1)}
            size="sm"
          />
          <IconButton
            aria-label={`Move ${collection.name} down`}
            disabled={isLast}
            icon="chevron-down"
            onClick={() => onMove(collection, 1)}
            size="sm"
          />
          <IconButton
            aria-label={`Delete ${collection.name}`}
            icon="trash"
            onClick={() => setConfirmingDelete(true)}
            size="sm"
            variant="danger"
          />
        </div>
      </div>
      {pickingEmoji ? (
        <EmojiChoices
          label={`Emoji for ${collection.name}`}
          onChange={(emoji) => {
            void changeEmoji(emoji);
          }}
          value={collection.emoji}
        />
      ) : null}
    </li>
  );
};

/** Rename, re-emoji, reorder and delete collections, and add new ones. */
export const ManageCollectionsSheet: React.FC<ManageCollectionsSheetProps> = ({
  open,
  onClose
}) => {
  const { collections, status } = useCollections();
  const { recipes } = useSavedRecipes();
  const { showToast } = useToast();
  const [creating, setCreating] = useState(false);
  const counts = useMemo(() => countRecipesByCollection(recipes), [recipes]);
  const showForm = creating || (status === "ready" && collections.length === 0);

  const showError = (message: string) => {
    showToast({ message, tone: "danger" });
  };

  const handleMove = (collection: WebCollection, direction: -1 | 1) => {
    const ids = collections.map((entry) => entry.id);
    const index = ids.indexOf(collection.id);
    const target = index + direction;

    if (index < 0 || target < 0 || target >= ids.length) {
      return;
    }

    [ids[index], ids[target]] = [ids[target] ?? collection.id, collection.id];
    void reorderCollections(ids).catch(() => showError("The new order couldn't be saved."));
  };

  const handleCreate = async (input: { name: string; emoji?: string | undefined }) => {
    try {
      await createCollection(input);
      setCreating(false);
    } catch (error) {
      throw new Error(getCollectionErrorMessage(error, "That collection couldn't be created."), {
        cause: error
      });
    }
  };

  return (
    <Sheet
      className="collection-sheet"
      description="Group recipes your way. Recipes can live in more than one collection."
      footer={
        <Button onClick={onClose} variant="primary">
          Done
        </Button>
      }
      onClose={onClose}
      open={open}
      size="sm"
      testId="manage-collections-sheet"
      title="Collections"
    >
      {collections.length > 0 ? (
        <ul aria-label="Your collections" className="collection-list collection-manage-list">
          {collections.map((collection, index) => (
            <CollectionRow
              collection={collection}
              count={counts.get(collection.id) ?? 0}
              isFirst={index === 0}
              isLast={index === collections.length - 1}
              key={collection.id}
              onError={showError}
              onMove={handleMove}
            />
          ))}
        </ul>
      ) : status === "ready" ? (
        <p className="collection-sheet-hint">
          No collections yet. Start one for weeknight dinners, holiday baking, or anything else.
        </p>
      ) : null}
      {showForm ? (
        <div className="collection-sheet-section">
          <h3 className="collection-sheet-subtitle">New collection</h3>
          <CollectionForm
            onCancel={collections.length > 0 ? () => setCreating(false) : undefined}
            onSubmit={handleCreate}
          />
        </div>
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
