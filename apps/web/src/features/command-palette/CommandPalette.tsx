import {
  createRecipeSearchIndex,
  getRecipeTimes,
  recipeSearchFields,
  recipeSourceLabel
} from "@linkdish/recipe-domain";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { Icon } from "../../components/Icon";
import { RecipeImage } from "../../components/RecipeImage";
import { useToast } from "../../components/Toast";
import { useBodyScrollLock } from "../../components/use-body-scroll-lock";
import { useModalFocusTrap } from "../../components/use-modal-focus-trap";
import { useSavedRecipes } from "../../data/library-store";
import { isMacLike } from "../../lib/shortcuts";
import { useMediaQuery } from "../../lib/use-media-query";
import { resolveTheme, setPreference, usePreference } from "../../preferences/preferences-store";
import { addParsedShoppingItems, parseManualShoppingLine } from "../shopping/shopping-list-store";
import {
  getShoppingWriteOptions,
  requestShoppingSync,
  useShoppingAccount
} from "../shopping/shopping-sync";

import { buildPaletteSections, flattenSections, stepGroup } from "./palette-model";

import type { PaletteAction, PaletteItem } from "./palette-model";
import type { OpenCommandPaletteDetail } from "../../lib/command-palette-events";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { HighlightRange } from "@linkdish/recipe-domain";

import "./CommandPalette.css";

export interface CommandPaletteProps {
  source: OpenCommandPaletteDetail["source"];
  onClose: () => void;
  onShowShortcuts: () => void;
}

const describeRecipe = (recipe: WebSavedRecipe): string | undefined => {
  const parts = [
    recipe.isStarter ? "Starter recipe" : recipeSourceLabel(recipe.sourceUrl),
    getRecipeTimes(recipe.recipe).labels.total
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" · ") : undefined;
};

const analyticsAction = (action: PaletteAction): string => {
  switch (action.type) {
    case "navigate":
      return action.analytics;
    case "open-recipe":
      return "open_recipe";
    case "cook-recipe":
      return "start_cooking";
    case "import-url":
      return "import_url";
    case "add-shopping":
      return "add_to_shopping_list";
    case "set-theme":
      return "switch_theme";
    case "show-shortcuts":
      return "keyboard_shortcuts";
  }
};

const Highlighted: React.FC<{ text: string; ranges: HighlightRange[] }> = ({ ranges, text }) => {
  if (ranges.length === 0) {
    return <>{text}</>;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push(text.slice(cursor, range.start));
    }

    parts.push(
      <mark className="command-palette-mark" key={range.start}>
        {text.slice(range.start, range.end)}
      </mark>
    );
    cursor = range.end;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return <>{parts}</>;
};

const Keys: React.FC<{ keys: readonly string[] }> = ({ keys }) => (
  <span className="command-palette-keys" aria-hidden="true">
    {keys.map((key) => (
      <kbd key={key}>{key}</kbd>
    ))}
  </span>
);

/**
 * ⌘K: one search box for recipes, places and actions. A combobox over a grouped listbox with
 * the active option tracked by aria-activedescendant, so focus never leaves the input.
 */
export const CommandPalette: React.FC<CommandPaletteProps> = ({
  onClose,
  onShowShortcuts,
  source
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const library = useSavedRecipes();
  const theme = usePreference("theme");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const mac = isMacLike();
  const roomy = useMediaQuery("(min-width: 768px)");

  useShoppingAccount();
  useModalFocusTrap({ active: true, containerRef: panelRef, onEscape: onClose });
  useBodyScrollLock(true);

  const recipes = library.recipes;
  const index = useMemo(
    () =>
      createRecipeSearchIndex(recipes, (recipe) =>
        recipeSearchFields(recipe.recipe, { notes: recipe.notes, tags: recipe.tags })
      ),
    [recipes]
  );
  const searchRecipes = useCallback(
    (text: string, limit: number) =>
      index.search(text, { limit }).map((result) => ({
        recipe: result.record,
        titleMatch: result.matches.includes("title")
      })),
    [index]
  );
  const sections = useMemo(
    () =>
      buildPaletteSections({
        describeRecipe,
        query,
        recipes,
        resolvedTheme: resolveTheme(theme),
        searchRecipes
      }),
    [query, recipes, searchRecipes, theme]
  );
  const items = useMemo(() => flattenSections(sections), [sections]);
  const safeIndex = items.length === 0 ? -1 : Math.min(activeIndex, items.length - 1);
  const activeItem = safeIndex >= 0 ? items[safeIndex] : undefined;
  const optionId = (item: PaletteItem) => `${baseId}-${item.id}`;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the active option in view as it moves.
  const activeOptionId = activeItem ? optionId(activeItem) : undefined;

  useEffect(() => {
    if (activeOptionId) {
      document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeOptionId]);

  const run = async (action: PaletteAction) => {
    trackWebEvent({
      eventName: "command_palette_used",
      properties: {
        action: analyticsAction(action),
        has_query: query.trim().length > 0,
        source
      },
      routeOrScreen: location.pathname
    });

    switch (action.type) {
      case "open-recipe":
        onClose();
        void navigate(`/recipes/${encodeURIComponent(action.recipeId)}`);
        return;
      case "cook-recipe":
        onClose();
        void navigate(`/recipes/${encodeURIComponent(action.recipeId)}?cook=1`);
        return;
      case "navigate":
        onClose();
        void navigate(action.to);
        return;
      case "import-url":
        onClose();
        void navigate(`/import?url=${encodeURIComponent(action.url)}`);
        return;
      case "set-theme":
        setPreference("theme", action.theme);
        onClose();
        return;
      case "show-shortcuts":
        onClose();
        onShowShortcuts();
        return;
      case "add-shopping": {
        const parsed = parseManualShoppingLine(action.text);
        onClose();

        if (!parsed) {
          return;
        }

        try {
          await addParsedShoppingItems([parsed], getShoppingWriteOptions());
          requestShoppingSync();
          trackWebEvent({
            eventName: "shopping_item_added",
            properties: { count: 1, method: "command_palette", source: "manual" },
            routeOrScreen: location.pathname
          });
          showToast({
            action: { label: "View list", onClick: () => void navigate("/shopping") },
            icon: "shopping-basket",
            id: "palette-shopping-added",
            message: `Added “${parsed.text}” to your shopping list`,
            tone: "success"
          });
        } catch {
          showToast({
            id: "palette-shopping-added",
            message: "That couldn't be added to your shopping list. Please try again.",
            tone: "danger"
          });
        }
      }
    }
  };

  const move = (delta: number) => {
    if (items.length === 0) {
      return;
    }

    setActiveIndex((current) => (current + delta + items.length) % items.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "PageDown":
        event.preventDefault();
        setActiveIndex((current) => Math.min(items.length - 1, current + 5));
        return;
      case "PageUp":
        event.preventDefault();
        setActiveIndex((current) => Math.max(0, current - 5));
        return;
      case "Tab":
        // Tab jumps between groups; the palette has nothing else to tab to.
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => stepGroup(sections, current, event.shiftKey ? -1 : 1));
        return;
      case "Enter": {
        if (!activeItem) {
          return;
        }

        event.preventDefault();
        const secondary = event.shiftKey || event.metaKey || event.ctrlKey;
        void run(
          secondary && activeItem.secondaryAction ? activeItem.secondaryAction : activeItem.action
        );
        return;
      }
      default:
    }
  };

  let optionIndex = -1;
  const libraryLoading = library.status === "loading" && recipes.length === 0;

  return createPortal(
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <div
        aria-label="Search and commands"
        aria-modal="true"
        className="command-palette"
        data-testid="command-palette"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="command-palette-search">
          <Icon className="command-palette-search-icon" name="search" size={20} />
          <input
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-label="Search recipes, pages and actions"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="command-palette-input"
            enterKeyHint="go"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={roomy ? "Search recipes, or type a command…" : "Search recipes and more"}
            role="combobox"
            spellCheck={false}
            type="text"
            value={query}
          />
          <kbd className="command-palette-esc" aria-hidden="true">
            esc
          </kbd>
          <button className="command-palette-cancel" onClick={onClose} type="button">
            Cancel
          </button>
        </div>

        <div className="command-palette-results" id={listId} role="listbox">
          {sections.map((section) => {
            const headingId = `${baseId}-${section.id}-label`;

            return (
              <div
                aria-labelledby={headingId}
                className="command-palette-group"
                key={section.id}
                role="group"
              >
                <div className="command-palette-group-label" id={headingId} role="presentation">
                  {section.label}
                </div>
                {section.items.map((item) => {
                  optionIndex += 1;
                  const index = optionIndex;
                  const active = index === safeIndex;

                  return (
                    <div
                      aria-selected={active}
                      className={`command-palette-option${active ? " is-active" : ""}${item.recipe ? " is-recipe" : ""}`}
                      id={optionId(item)}
                      key={item.id}
                      onClick={() => void run(item.action)}
                      onMouseMove={() => {
                        if (!active) {
                          setActiveIndex(index);
                        }
                      }}
                      role="option"
                    >
                      {item.recipe ? (
                        <RecipeImage
                          aspectRatio="1 / 1"
                          className="command-palette-thumb"
                          image={item.recipe.recipe.image}
                          sizes="44px"
                          title={item.label}
                          widths={[96]}
                        />
                      ) : (
                        <span className="command-palette-icon" aria-hidden="true">
                          <Icon name={item.icon} size={18} />
                        </span>
                      )}
                      <span className="command-palette-copy">
                        <span className="command-palette-label">
                          <Highlighted ranges={item.highlights} text={item.label} />
                        </span>
                        {item.description ? (
                          <span className="command-palette-description">{item.description}</span>
                        ) : null}
                        {item.secondaryAction ? (
                          <span className="sr-only">. Shift+Enter to start cooking.</span>
                        ) : null}
                      </span>
                      {item.secondaryAction ? (
                        <button
                          aria-hidden="true"
                          className="command-palette-cook"
                          onClick={(event) => {
                            event.stopPropagation();

                            if (item.secondaryAction) {
                              void run(item.secondaryAction);
                            }
                          }}
                          tabIndex={-1}
                          type="button"
                        >
                          <Icon name="chef-hat" size={roomy ? 16 : 19} />
                          <span className="command-palette-cook-label">Cook</span>
                        </button>
                      ) : item.shortcut ? (
                        <Keys keys={item.shortcut} />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {libraryLoading && !query ? (
            <p className="command-palette-note">Opening your cookbook…</p>
          ) : null}
        </div>

        <footer className="command-palette-footer" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          {activeItem?.secondaryAction ? (
            <span>
              <kbd>⇧</kbd>
              <kbd>↵</kbd> start cooking
            </span>
          ) : null}
          <span>
            <kbd>tab</kbd> next group
          </span>
          <span className="command-palette-footer-toggle">
            <kbd>{mac ? "⌘" : "Ctrl"}</kbd>
            <kbd>K</kbd> close
          </span>
        </footer>

        <p aria-live="polite" className="sr-only">
          {items.length === 0 ? "No results" : `${items.length} results`}
        </p>
      </div>
    </div>,
    document.body
  );
};
