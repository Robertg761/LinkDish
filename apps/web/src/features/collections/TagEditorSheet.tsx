import { inferRecipeTags } from "@linkdish/recipe-domain";
import React, { useId, useMemo, useRef, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { useToast } from "../../components/Toast";
import { setTags, useSavedRecipes } from "../../data/library-store";
import { normalizeRecipeTags } from "../library/saved-recipe-store";

import "./CollectionsSheets.css";

export interface TagEditorSheetProps {
  open: boolean;
  onClose: () => void;
  recipeId: string;
}

const MAX_SUGGESTIONS = 10;
const MAX_OWN_TAGS = 8;
const TAG_SEPARATOR_PATTERN = /[,\n]/u;

/** Every tag used across the cookbook, most used first (first spelling wins). */
const collectCookbookTags = (tagLists: ReadonlyArray<readonly string[] | undefined>): string[] => {
  const counts = new Map<string, { label: string; count: number }>();

  for (const tags of tagLists) {
    for (const tag of tags ?? []) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);

      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, { count: 1, label: tag });
      }
    }
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .map((entry) => entry.label);
};

const TagChoices: React.FC<{
  title: string;
  label: string;
  tags: readonly string[];
  onAdd: (tag: string) => void;
}> = ({ title, label, tags, onAdd }) => (
  <div className="tag-editor-suggestions">
    <h3 className="collection-sheet-subtitle">{title}</h3>
    <ul aria-label={label} className="tag-editor-suggestion-list">
      {tags.map((tag) => (
        <li key={tag}>
          <button
            aria-label={`Add tag ${tag}`}
            className="tag-suggestion"
            onClick={() => onAdd(tag)}
            type="button"
          >
            <Icon name="plus" size={14} strokeWidth={2.4} />
            {tag}
          </button>
        </li>
      ))}
    </ul>
  </div>
);

/**
 * Tags for one recipe as removable chips, with an input (Enter or comma adds) and suggestions
 * from the recipe itself (course, cuisine, method, diet, quick) and the cook's existing tags.
 * Every change saves immediately.
 */
export const TagEditorSheet: React.FC<TagEditorSheetProps> = ({ open, onClose, recipeId }) => {
  const { recipes } = useSavedRecipes();
  const { showToast } = useToast();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const recipe = useMemo(() => recipes.find((entry) => entry.id === recipeId), [recipeId, recipes]);
  const tags = useMemo(() => recipe?.tags ?? [], [recipe?.tags]);
  const tagKeys = useMemo(() => new Set(tags.map((tag) => tag.toLowerCase())), [tags]);

  /*
   * Two honest lists: tags read from this recipe ("Suggested for this recipe"), then the cook's
   * other tags ("Your tags"), the ones this recipe's title or ingredients mention first. A curry
   * is no longer offered "Dessert" under a heading that claims it fits.
   */
  const { ownTags, suggestions } = useMemo(() => {
    if (!recipe) {
      return { ownTags: [], suggestions: [] };
    }

    const existing = collectCookbookTags(recipes.map((entry) => entry.tags));
    const existingByKey = new Map(existing.map((tag) => [tag.toLowerCase(), tag]));
    const seen = new Set(tagKeys);
    const fresh = (tag: string) => {
      const key = tag.toLowerCase();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    };
    // Prefer the cook's own spelling of a tag; otherwise capitalize the suggestion.
    const inferred = inferRecipeTags(recipe.recipe)
      .tags.map(
        (tag) =>
          existingByKey.get(tag.toLowerCase()) ?? `${tag.charAt(0).toUpperCase()}${tag.slice(1)}`
      )
      .filter(fresh)
      .slice(0, MAX_SUGGESTIONS);
    const text = [recipe.recipe.title, ...recipe.recipe.ingredients.map((entry) => entry.text)]
      .join(" ")
      .toLowerCase();
    const mentioned = (tag: string) => (text.includes(tag.toLowerCase()) ? 0 : 1);
    const own = existing
      .map((tag, rank) => ({ rank, tag }))
      .sort((left, right) => mentioned(left.tag) - mentioned(right.tag) || left.rank - right.rank)
      .map((entry) => entry.tag)
      .filter(fresh)
      .slice(0, MAX_OWN_TAGS);

    return { ownTags: own, suggestions: inferred };
  }, [recipe, recipes, tagKeys]);

  const saveTags = async (next: readonly string[]) => {
    try {
      await setTags(recipeId, next);
    } catch {
      showToast({ message: "Those tags couldn't be saved. Please try again.", tone: "danger" });
    }
  };

  const addTags = (raw: string) => {
    const incoming = normalizeRecipeTags(raw.split(TAG_SEPARATOR_PATTERN));

    if (incoming.length === 0) {
      return;
    }

    void saveTags(normalizeRecipeTags([...tags, ...incoming]));
  };

  const removeTag = (tag: string) => {
    void saveTags(tags.filter((entry) => entry !== tag));
  };

  const commitDraft = () => {
    if (draft.trim()) {
      addTags(draft);
      setDraft("");
    }
  };

  const handleClose = () => {
    commitDraft();
    onClose();
  };

  return (
    <Sheet
      className="collection-sheet tag-editor"
      description={recipe ? recipe.recipe.title : undefined}
      footer={
        <Button onClick={handleClose} variant="primary">
          Done
        </Button>
      }
      onClose={handleClose}
      open={open}
      size="sm"
      testId="tag-editor-sheet"
      title="Tags"
    >
      <div className="tag-editor-field" onClick={() => inputRef.current?.focus()}>
        <ul aria-label="Tags on this recipe" className="tag-editor-chips">
          {tags.map((tag) => (
            <li className="tag-chip" key={tag}>
              <span>{tag}</span>
              <button
                aria-label={`Remove tag ${tag}`}
                className="tag-chip-remove"
                onClick={(event) => {
                  event.stopPropagation();
                  removeTag(tag);
                }}
                type="button"
              >
                <Icon name="x" size={13} strokeWidth={2.6} />
              </button>
            </li>
          ))}
        </ul>
        <label className="sr-only" htmlFor={inputId}>
          Add a tag
        </label>
        <input
          autoCapitalize="none"
          className="tag-editor-input"
          enterKeyHint="done"
          id={inputId}
          onBlur={commitDraft}
          onChange={(event) => {
            const value = event.target.value;

            if (TAG_SEPARATOR_PATTERN.test(value)) {
              addTags(value);
              setDraft("");
            } else {
              setDraft(value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitDraft();
            } else if (event.key === "Backspace" && !draft && tags.length > 0) {
              removeTag(tags[tags.length - 1] ?? "");
            }
          }}
          placeholder={tags.length ? "Add another tag" : "Add a tag, like weeknight"}
          ref={inputRef}
          value={draft}
        />
      </div>

      {suggestions.length > 0 ? (
        <TagChoices
          label="Suggested tags"
          onAdd={addTags}
          tags={suggestions}
          title="Suggested for this recipe"
        />
      ) : null}
      {ownTags.length > 0 ? (
        <TagChoices label="Your tags" onAdd={addTags} tags={ownTags} title="Your tags" />
      ) : null}
      <p className="collection-sheet-hint">
        Tags show up as filters in your Cookbook and help search find this recipe.
      </p>
    </Sheet>
  );
};
