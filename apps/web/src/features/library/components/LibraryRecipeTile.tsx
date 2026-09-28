import React, { memo, useMemo } from "react";

import { Badge } from "../../../components/Badge";
import { IconButton } from "../../../components/IconButton";
import { Menu } from "../../../components/Menu";
import { RecipeCard } from "../../../components/RecipeCard";

import { HighlightedText } from "./HighlightedText";
import { formatRecipeMeta, isStarterRecipe, normalizeText } from "./library-model";
import { CompactRecipeMeta } from "./RecipeMeta";

import type { TextHighlighter } from "./HighlightedText";
import type { LibraryView } from "./library-model";
import type { MenuEntry } from "../../../components/Menu";
import type { WebSavedRecipe } from "../saved-recipe-types";

export type LibraryRecipeAction =
  | "collections"
  | "tags"
  | "shopping"
  | "family"
  | "duplicate"
  | "delete";

interface LibraryRecipeTileProps {
  recipe: WebSavedRecipe;
  view: LibraryView;
  /** Eager-load the photo (the first cards on screen). */
  priority?: boolean | undefined;
  /** Marks search matches in the title. */
  highlight?: TextHighlighter | undefined;
  /** Offer "Share to Family" (signed in with an active household). */
  canShareToFamily?: boolean | undefined;
  onAction: (action: LibraryRecipeAction, recipe: WebSavedRecipe) => void;
  onToggleFavorite: (recipe: WebSavedRecipe) => void;
  /** Called when the overflow menu opens (e.g. to warm lazy sheets). */
  onMenuOpen?: (() => void) | undefined;
}

interface StatusBadge {
  key: string;
  label: string;
  tone: "neutral" | "primary" | "butter" | "danger";
  icon?: "users" | "chef-hat" | "alert-circle" | "refresh" | "sparkles" | undefined;
}

const getStatusBadges = (recipe: WebSavedRecipe): StatusBadge[] => {
  const badges: StatusBadge[] = [];

  if (isStarterRecipe(recipe)) {
    badges.push({ icon: "sparkles", key: "starter", label: "Starter", tone: "butter" });
  }

  if (recipe.sync?.status === "synced") {
    badges.push({ icon: "users", key: "sync", label: "Family", tone: "primary" });
  } else if (recipe.sync?.status === "dirty") {
    badges.push({ icon: "refresh", key: "sync", label: "Edits to sync", tone: "butter" });
  } else if (recipe.sync?.status === "sync_failed") {
    badges.push({ icon: "alert-circle", key: "sync", label: "Sync failed", tone: "danger" });
  }

  const timesCooked = recipe.timesCooked ?? 0;

  if (timesCooked > 0) {
    badges.push({
      icon: "chef-hat",
      key: "cooked",
      label: `Cooked ${timesCooked}×`,
      tone: "neutral"
    });
  }

  return badges;
};

const familyMenuLabel = (recipe: WebSavedRecipe): string | null => {
  switch (recipe.sync?.status) {
    case "synced":
      return null;
    case "dirty":
      return "Sync changes to Family";
    case "sync_failed":
      return "Retry Family sync";
    default:
      return "Share to Family";
  }
};

/** A personal cookbook card: photo, title, meta, favorite heart and an overflow menu. */
const LibraryRecipeTileComponent: React.FC<LibraryRecipeTileProps> = ({
  recipe,
  view,
  priority = false,
  highlight,
  canShareToFamily = false,
  onAction,
  onToggleFavorite,
  onMenuOpen
}) => {
  const title = normalizeText(recipe.recipe.title);
  const isList = view === "list";
  const favorite = Boolean(recipe.favorite);
  const badges = useMemo(() => getStatusBadges(recipe), [recipe]);

  const menuItems = useMemo<MenuEntry[]>(() => {
    const familyLabel =
      canShareToFamily && !isStarterRecipe(recipe) ? familyMenuLabel(recipe) : null;

    return [
      {
        icon: "folder-plus",
        id: "collections",
        label: "Add to collection…",
        onSelect: () => onAction("collections", recipe)
      },
      { icon: "tag", id: "tags", label: "Edit tags…", onSelect: () => onAction("tags", recipe) },
      {
        icon: "shopping-basket",
        id: "shopping",
        label: "Add to shopping list",
        onSelect: () => onAction("shopping", recipe)
      },
      ...(familyLabel
        ? [
            {
              icon: "users" as const,
              id: "family",
              label: familyLabel,
              onSelect: () => onAction("family", recipe)
            }
          ]
        : []),
      {
        icon: "copy",
        id: "duplicate",
        label: "Duplicate",
        onSelect: () => onAction("duplicate", recipe)
      },
      { id: "separator", type: "separator" },
      {
        icon: "trash",
        id: "delete",
        label: "Delete",
        onSelect: () => onAction("delete", recipe),
        tone: "danger"
      }
    ];
  }, [canShareToFamily, onAction, recipe]);

  const badgeNodes = badges.map((badge) => (
    <Badge
      className={isList ? undefined : "library-media-badge"}
      icon={badge.icon}
      key={badge.key}
      tone={badge.tone}
    >
      {badge.label}
    </Badge>
  ));

  return (
    <RecipeCard
      actionsSlot={
        <Menu
          items={menuItems}
          label={`Actions for ${title}`}
          onOpenChange={(open) => {
            if (open) {
              onMenuOpen?.();
            }
          }}
          renderTrigger={(props) => (
            <IconButton
              aria-label={`More actions for ${title}`}
              icon="more-horizontal"
              size="sm"
              {...props}
            />
          )}
        />
      }
      badges={isList && badgeNodes.length ? badgeNodes : undefined}
      className="library-card"
      favoriteSlot={
        <IconButton
          aria-label={`Favorite ${title}`}
          className="library-favorite"
          icon="heart"
          onClick={() => onToggleFavorite(recipe)}
          pressed={favorite}
          pressedIcon="heart-filled"
          size={isList ? "md" : "sm"}
        />
      }
      image={recipe.recipe.image}
      mediaBadges={!isList && badgeNodes.length ? badgeNodes.slice(0, 2) : undefined}
      meta={
        isList ? (
          formatRecipeMeta(recipe.recipe, { includeSource: true })
        ) : (
          <CompactRecipeMeta recipe={recipe.recipe} />
        )
      }
      priority={priority}
      title={title}
      titleContent={highlight ? <HighlightedText highlight={highlight} text={title} /> : undefined}
      to={`/recipes/${recipe.id}`}
      variant={view}
    />
  );
};

export const LibraryRecipeTile = memo(LibraryRecipeTileComponent);
