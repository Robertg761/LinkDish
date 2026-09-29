import React, { useId, useState } from "react";

import { Button } from "../../components/Button";
import { MAX_COLLECTION_NAME_LENGTH } from "../../data/collections-store";

import { EmojiChoices } from "./EmojiChoices";

import "./CollectionsSheets.css";

interface CollectionFormProps {
  /** Resolves once saved; throw to keep the form open (the message is shown). */
  onSubmit: (input: { name: string; emoji?: string | undefined }) => Promise<void>;
  onCancel?: (() => void) | undefined;
  submitLabel?: string | undefined;
  /** Placeholder for the name field. */
  placeholder?: string | undefined;
}

/** Name + optional emoji for a new collection. */
export const CollectionForm: React.FC<CollectionFormProps> = ({
  onSubmit,
  onCancel,
  submitLabel = "Create",
  placeholder = "Weeknight dinners"
}) => {
  const nameId = useId();
  const errorId = useId();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!name.trim()) {
      setError("Give the collection a name.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await onSubmit({ emoji, name });
      setName("");
      setEmoji(undefined);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label="New collection"
      className="collection-form"
      noValidate
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <div className="collection-form-row">
        <span aria-hidden="true" className="collection-emoji-tile collection-form-preview">
          {emoji ?? "📁"}
        </span>
        <div className="collection-form-field">
          <label className="collection-form-label" htmlFor={nameId}>
            Collection name
          </label>
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            className="collection-form-input"
            id={nameId}
            maxLength={MAX_COLLECTION_NAME_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder={placeholder}
            value={name}
          />
        </div>
      </div>
      <EmojiChoices label="Collection emoji" onChange={setEmoji} value={emoji} />
      {error ? (
        <p className="collection-form-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <div className="collection-form-actions">
        {onCancel ? (
          <Button onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
        ) : null}
        <Button icon="plus" loading={saving} size="sm" type="submit" variant="primary">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};
