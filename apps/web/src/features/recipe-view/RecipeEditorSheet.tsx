import React, { useEffect, useMemo, useRef, useState } from "react";

import { getFriendlyErrorMessage } from "../../api/error-message";
import { Button } from "../../components/Button";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { Field, TextAreaField } from "../../components/Field";
import { Sheet } from "../../components/Sheet";

import {
  formatEditableIngredients,
  formatEditableSteps,
  isHttpUrl,
  parseMinutesField,
  splitEditableIngredients,
  splitEditableLines
} from "./recipe-editing";

import type { Recipe } from "@linkdish/recipe-domain";

import "./RecipeEditorSheet.css";

/** What the cook changed since the editor opened. */
export interface RecipeEditorChanges {
  /** The recipe fields the cook changed (with `sourceUrl` when the link changed). */
  recipe: Partial<Recipe>;
  /** The new notes (`null` when cleared); present only when the cook changed them. */
  notes?: string | null | undefined;
}

export interface RecipeEditorValues {
  /** The recipe as it is now, with the cook's changes (a family recipe is saved whole). */
  recipe: Recipe;
  notes: string | null;
  /** Present only when the source link was editable and changed. */
  sourceUrl?: string | undefined;
  /**
   * Only what the cook changed. A saved recipe writes just these, so a note or edit saved in
   * another tab while the editor was open is kept.
   */
  changes: RecipeEditorChanges;
}

interface RecipeEditorSheetProps {
  open: boolean;
  onClose: () => void;
  recipe: Recipe;
  notes: string | null | undefined;
  /** The source link is editable for web recipes, never for photo imports. */
  sourceUrl?: string | null | undefined;
  onSave: (values: RecipeEditorValues) => Promise<void>;
  title?: string | undefined;
}

interface Draft {
  title: string;
  description: string;
  servings: string;
  prep: string;
  cook: string;
  ingredients: string;
  steps: string;
  sourceUrl: string;
  notes: string;
}

type DraftErrors = Partial<Record<keyof Draft, string>>;

const toDraft = (recipe: Recipe, notes: string | null | undefined, sourceUrl: string): Draft => ({
  cook: recipe.cookTimeMinutes == null ? "" : String(recipe.cookTimeMinutes),
  description: recipe.description ?? "",
  ingredients: formatEditableIngredients(recipe.ingredients),
  notes: notes ?? "",
  prep: recipe.prepTimeMinutes == null ? "" : String(recipe.prepTimeMinutes),
  servings: recipe.servings ?? "",
  sourceUrl,
  steps: formatEditableSteps(recipe.steps),
  title: recipe.title
});

/* What each field saves, read from its text: two texts that save the same value are no change. */
const titleOf = (draft: Draft) => draft.title.trim();
const descriptionOf = (draft: Draft) => draft.description.trim() || null;
const servingsOf = (draft: Draft) => draft.servings.trim() || null;
const prepOf = (draft: Draft) => parseMinutesField(draft.prep);
const cookOf = (draft: Draft) => parseMinutesField(draft.cook);
const ingredientsOf = (draft: Draft) => splitEditableIngredients(draft.ingredients);
const stepsOf = (draft: Draft) =>
  splitEditableLines(draft.steps).map((text, index) => ({ index: index + 1, text }));
const sourceUrlOf = (draft: Draft) => draft.sourceUrl.trim();
const notesOf = (draft: Draft) => draft.notes.trim() || null;

/**
 * The recipe fields whose saved value differs between the draft the editor opened with and the
 * cook's draft. Call it with a valid draft (see {@link validate}).
 */
const changedRecipeFields = (
  opened: Draft,
  draft: Draft,
  sourceEditable: boolean
): Partial<Recipe> => {
  const changed = (valueOf: (value: Draft) => unknown) =>
    JSON.stringify(valueOf(draft)) !== JSON.stringify(valueOf(opened));
  const prep = prepOf(draft);
  const cook = cookOf(draft);

  return {
    ...(changed(titleOf) ? { title: titleOf(draft) } : {}),
    ...(changed(descriptionOf) ? { description: descriptionOf(draft) } : {}),
    ...(changed(servingsOf) ? { servings: servingsOf(draft) } : {}),
    ...(prep !== "invalid" && changed(prepOf) ? { prepTimeMinutes: prep } : {}),
    ...(cook !== "invalid" && changed(cookOf) ? { cookTimeMinutes: cook } : {}),
    ...(changed(ingredientsOf) ? { ingredients: ingredientsOf(draft) } : {}),
    ...(changed(stepsOf) ? { steps: stepsOf(draft) } : {}),
    ...(sourceEditable && changed(sourceUrlOf) ? { sourceUrl: sourceUrlOf(draft) } : {})
  };
};

const validate = (draft: Draft, sourceEditable: boolean): DraftErrors => {
  const errors: DraftErrors = {};

  if (!draft.title.trim()) {
    errors.title = "Give the recipe a name.";
  }

  if (splitEditableIngredients(draft.ingredients).length === 0) {
    errors.ingredients = "Add at least one ingredient.";
  }

  if (splitEditableLines(draft.steps).length === 0) {
    errors.steps = "Add at least one step.";
  }

  if (parseMinutesField(draft.prep) === "invalid") {
    errors.prep = "Whole minutes, e.g. 15.";
  }

  if (parseMinutesField(draft.cook) === "invalid") {
    errors.cook = "Whole minutes, e.g. 40.";
  }

  if (sourceEditable && !isHttpUrl(draft.sourceUrl)) {
    errors.sourceUrl = "Use a full link starting with https://";
  }

  return errors;
};

/**
 * Full recipe editor in a large sheet (full screen on phones). It keeps its own draft state, so
 * typing never re-renders the recipe page behind it, and asks before throwing edits away.
 */
export const RecipeEditorSheet: React.FC<RecipeEditorSheetProps> = ({
  open,
  onClose,
  recipe,
  notes,
  sourceUrl,
  onSave,
  title = "Edit recipe"
}) => {
  const sourceEditable = sourceUrl != null;
  const initial = useMemo(
    () => toDraft(recipe, notes, sourceUrl ?? ""),
    [notes, recipe, sourceUrl]
  );
  // What the editor opened with: the recipe on screen may change meanwhile (another tab saves).
  const [opened, setOpened] = useState<Draft>(initial);
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const wasOpenRef = useRef(false);

  // A fresh draft every time the sheet opens.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setOpened(initial);
      setDraft(initial);
      setErrors({});
      setFormError("");
      setConfirmDiscard(false);
    }

    wasOpenRef.current = open;
  }, [initial, open]);

  const dirty = (Object.keys(opened) as Array<keyof Draft>).some(
    (key) => draft[key] !== opened[key]
  );

  const update =
    (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      setDraft((current) => ({ ...current, [key]: value }));

      if (errors[key]) {
        setErrors((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    };

  const requestClose = () => {
    if (saving || confirmDiscard) {
      return;
    }

    if (dirty) {
      setConfirmDiscard(true);
      return;
    }

    onClose();
  };

  const save = async () => {
    const nextErrors = validate(draft, sourceEditable);
    setErrors(nextErrors);
    setFormError("");

    if (Object.keys(nextErrors).length > 0) {
      setFormError("A few things need a look before saving.");
      return;
    }

    // Only what the cook changed: the rest may have been changed elsewhere since the editor opened.
    const recipeChanges = changedRecipeFields(opened, draft, sourceEditable);
    const notesChanged = notesOf(draft) !== notesOf(opened);

    setSaving(true);

    try {
      await onSave({
        changes: {
          recipe: recipeChanges,
          ...(notesChanged ? { notes: notesOf(draft) } : {})
        },
        notes: notesChanged ? notesOf(draft) : notes?.trim() || null,
        recipe: { ...recipe, ...recipeChanges },
        ...(recipeChanges.sourceUrl ? { sourceUrl: recipeChanges.sourceUrl } : {})
      });
      onClose();
    } catch (error) {
      setFormError(getFriendlyErrorMessage(error, "save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Sheet
        className="recipe-editor-sheet"
        dismissible={!saving && !confirmDiscard}
        footer={
          <>
            <Button disabled={saving} onClick={requestClose} variant="ghost">
              Cancel
            </Button>
            <Button loading={saving} onClick={() => void save()}>
              Save changes
            </Button>
          </>
        }
        onClose={requestClose}
        open={open}
        size="lg"
        testId="recipe-editor"
        title={title}
      >
        <form
          className="recipe-editor-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {formError ? (
            <p className="recipe-editor-error" role="alert">
              {formError}
            </p>
          ) : null}

          <TextAreaField
            autoComplete="off"
            error={errors.title}
            label="Title"
            onChange={update("title")}
            singleLine
            value={draft.title}
          />
          <TextAreaField
            autoGrow
            hint="A line or two about the dish (optional)."
            label="Description"
            onChange={update("description")}
            rows={2}
            value={draft.description}
          />
          <div className="recipe-editor-grid">
            <Field
              label="Servings"
              onChange={update("servings")}
              placeholder="4 servings"
              value={draft.servings}
            />
            <Field
              error={errors.prep}
              inputMode="numeric"
              label="Prep (min)"
              onChange={update("prep")}
              placeholder="15"
              value={draft.prep}
            />
            <Field
              error={errors.cook}
              inputMode="numeric"
              label="Cook (min)"
              onChange={update("cook")}
              placeholder="30"
              value={draft.cook}
            />
          </div>
          <TextAreaField
            autoGrow
            className="recipe-editor-lines"
            error={errors.ingredients}
            hint="One per line. End a line with a colon to start a section, like “For the sauce:”."
            label="Ingredients"
            onChange={update("ingredients")}
            rows={6}
            spellCheck={false}
            value={draft.ingredients}
          />
          <TextAreaField
            autoGrow
            className="recipe-editor-lines"
            error={errors.steps}
            hint="One step per line."
            label="Method"
            onChange={update("steps")}
            rows={6}
            value={draft.steps}
          />
          {sourceEditable ? (
            <Field
              autoComplete="url"
              error={errors.sourceUrl}
              inputMode="url"
              label="Source link"
              onChange={update("sourceUrl")}
              type="url"
              value={draft.sourceUrl}
            />
          ) : null}
          <TextAreaField
            autoGrow
            label="Notes"
            onChange={update("notes")}
            placeholder="Swaps, timings, who loved it…"
            rows={3}
            value={draft.notes}
          />
          <button className="sr-only" tabIndex={-1} type="submit">
            Save
          </button>
        </form>
      </Sheet>

      <ConfirmationDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard"
        message={`Your edits to “${recipe.title}” haven’t been saved.`}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        title="Discard changes?"
        visible={open && confirmDiscard}
      />
    </>
  );
};
