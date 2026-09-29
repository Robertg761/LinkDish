import React, { memo, useMemo } from "react";

import { Badge } from "../../../components/Badge";
import { IconButton } from "../../../components/IconButton";
import { Menu } from "../../../components/Menu";
import { RecipeCard } from "../../../components/RecipeCard";
import { getSharedRecipeOwnerLabel } from "../saved-recipe-store";

import { HighlightedText } from "./HighlightedText";
import { normalizeText } from "./library-model";
import { CompactRecipeMeta, RecipeMetaLine } from "./RecipeMeta";

import type { TextHighlighter } from "./HighlightedText";
import type { LibraryView } from "./library-model";
import type { MenuEntry } from "../../../components/Menu";
import type { SharedRecipe } from "@linkdish/api-contracts";

export type SharedRecipeAction = "save-copy" | "remove";

interface SharedRecipeTileProps {
  recipe: SharedRecipe;
  view: LibraryView;
  isOwner: boolean;
  priority?: boolean | undefined;
  /** Marks search matches in the title. */
  highlight?: TextHighlighter | undefined;
  onAction: (action: SharedRecipeAction, recipe: SharedRecipe) => void;
}

/** A Family cookbook card: who added it, plus Save a copy / Remove from Family. */
const SharedRecipeTileComponent: React.FC<SharedRecipeTileProps> = ({
  recipe,
  view,
  isOwner,
  priority = false,
  highlight,
  onAction
}) => {
  const title = normalizeText(recipe.recipe.title);
  const owner = isOwner ? "You" : getSharedRecipeOwnerLabel(recipe);
  const menuItems = useMemo<MenuEntry[]>(
    () => [
      {
        icon: "copy",
        id: "save-copy",
        label: "Save a copy to Personal",
        onSelect: () => onAction("save-copy", recipe)
      },
      ...(isOwner
        ? [
            { id: "separator", type: "separator" as const },
            {
              icon: "trash" as const,
              id: "remove",
              label: "Remove from Family",
              onSelect: () => onAction("remove", recipe),
              tone: "danger" as const
            }
          ]
        : [])
    ],
    [isOwner, onAction, recipe]
  );

  return (
    <RecipeCard
      actionsSlot={
        <Menu
          items={menuItems}
          label={`Actions for ${title}`}
          presentation="adaptive"
          sheetTitle={title}
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
      className="library-card"
      image={recipe.recipe.image}
      badges={
        view === "list" ? (
          <Badge icon="user" tone="primary">
            Added by {owner}
          </Badge>
        ) : undefined
      }
      mediaBadges={
        <Badge className="library-media-badge" icon="user" tone="primary">
          {owner}
        </Badge>
      }
      meta={
        view === "list" ? (
          <RecipeMetaLine recipe={recipe.recipe} />
        ) : (
          <CompactRecipeMeta recipe={recipe.recipe} />
        )
      }
      priority={priority}
      title={title}
      titleContent={highlight ? <HighlightedText highlight={highlight} text={title} /> : undefined}
      to={`/recipes/shared/${recipe.id}`}
      variant={view}
    />
  );
};

export const SharedRecipeTile = memo(SharedRecipeTileComponent);
