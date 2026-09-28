import React, { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";

import "./NotesCard.css";

interface NotesCardProps {
  notes: string | null | undefined;
  /** Saves the notes (null clears them). Omit for read-only notes. */
  onSave?: ((notes: string | null) => Promise<void>) | undefined;
}

/** Personal notes with inline editing: swaps, timings, who loved it. */
export const NotesCard: React.FC<NotesCardProps> = ({ notes, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();
  const trimmed = notes?.trim() ?? "";

  useEffect(() => {
    if (!editing) {
      setDraft(notes ?? "");
    }
  }, [editing, notes]);

  useEffect(() => {
    if (editing) {
      const element = textareaRef.current;
      element?.focus();
      element?.setSelectionRange(element.value.length, element.value.length);
    }
  }, [editing]);

  if (!onSave && !trimmed) {
    return null;
  }

  const save = async () => {
    if (!onSave) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      await onSave(draft.trim() || null);
      setEditing(false);
    } catch {
      setError("Your note couldn’t be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className={`recipe-card notes-card${trimmed ? "" : " print-hide"}`}
    >
      <div className="notes-card-header">
        <h2 className="recipe-section-title" id={headingId}>
          <Icon name="sticky-note" size={18} /> Your notes
        </h2>
        {onSave && !editing && trimmed ? (
          <IconButton
            aria-label="Edit notes"
            className="print-hide"
            icon="pencil"
            onClick={() => setEditing(true)}
            size="sm"
          />
        ) : null}
      </div>

      {editing ? (
        <div className="notes-card-editor print-hide">
          <label className="sr-only" htmlFor={`${headingId}-input`}>
            Notes
          </label>
          <textarea
            id={`${headingId}-input`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(false);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                void save();
              }
            }}
            placeholder="Swaps, timings, who loved it…"
            ref={textareaRef}
            rows={4}
            value={draft}
          />
          {error ? (
            <p className="notes-card-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="notes-card-actions">
            <Button onClick={() => setEditing(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button loading={saving} onClick={() => void save()} size="sm">
              Save note
            </Button>
          </div>
        </div>
      ) : trimmed ? (
        <p className="notes-card-text">{trimmed}</p>
      ) : (
        <button
          className="notes-card-empty print-hide"
          onClick={() => setEditing(true)}
          type="button"
        >
          <Icon name="plus" size={16} /> Add a note: swaps, timings, who loved it
        </button>
      )}
    </section>
  );
};
