import React, { memo } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu } from "../../components/Menu";
import { RecipeImage } from "../../components/RecipeImage";
import { Stepper } from "../../components/Stepper";

import { noteIconFor, PLAN_ENTRY_DRAG_TYPE, SLOT_LABELS } from "./plan-utils";

import type { MenuEntry } from "../../components/Menu";
import type { MealPlanEntry } from "../../data/meal-plan-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

export type PlanEntryAction = "open" | "move" | "duplicate" | "remove";

interface PlanEntryCardProps {
  entry: MealPlanEntry;
  recipe: WebSavedRecipe | undefined;
  /** Servings shown when the entry has none of its own. */
  fallbackServings: number | undefined;
  draggable: boolean;
  onAction: (entry: MealPlanEntry, action: PlanEntryAction) => void;
  onServingsChange: (entry: MealPlanEntry, servings: number) => void;
}

/** A planned meal: photo (or note icon), slot, title, servings and a Menu of actions. */
const PlanEntryCardComponent: React.FC<PlanEntryCardProps> = ({
  entry,
  recipe,
  fallbackServings,
  draggable,
  onAction,
  onServingsChange
}) => {
  const isRecipe = Boolean(entry.recipeId);
  const servings = entry.servings ?? fallbackServings;
  const title = recipe?.recipe.title ?? entry.title;
  const menuItems: MenuEntry[] = [
    ...(isRecipe
      ? [
          {
            disabled: !recipe,
            icon: "book-open" as const,
            id: "open",
            label: "Open recipe",
            onSelect: () => onAction(entry, "open")
          }
        ]
      : []),
    {
      icon: "calendar-days",
      id: "move",
      label: "Move to…",
      onSelect: () => onAction(entry, "move")
    },
    {
      icon: "copy",
      id: "duplicate",
      label: "Duplicate to…",
      onSelect: () => onAction(entry, "duplicate")
    },
    { id: "separator", type: "separator" },
    {
      icon: "trash",
      id: "remove",
      label: "Remove",
      onSelect: () => onAction(entry, "remove"),
      tone: "danger"
    }
  ];

  return (
    <li
      className={`plan-entry${isRecipe ? " is-recipe" : " is-note"}`}
      draggable={draggable || undefined}
      onDragStart={
        draggable
          ? (event) => {
              event.dataTransfer.setData(PLAN_ENTRY_DRAG_TYPE, entry.id);
              event.dataTransfer.setData("text/plain", title);
              event.dataTransfer.effectAllowed = "move";
              event.currentTarget.classList.add("is-dragging");
            }
          : undefined
      }
      onDragEnd={
        draggable ? (event) => event.currentTarget.classList.remove("is-dragging") : undefined
      }
    >
      <div className="plan-entry-media">
        {isRecipe ? (
          <RecipeImage
            aspectRatio="auto"
            className="plan-entry-photo"
            image={recipe?.recipe.image}
            sizes="(min-width: 1024px) 160px, 72px"
            title={title}
            widths={[96, 480]}
          />
        ) : (
          <span aria-hidden="true" className="plan-entry-note-icon">
            <Icon name={noteIconFor(entry.title)} size={22} />
          </span>
        )}
      </div>
      <div className="plan-entry-body">
        <span className="plan-entry-slot">{SLOT_LABELS[entry.slot]}</span>
        {recipe ? (
          <Link className="plan-entry-title" to={`/recipes/${recipe.id}`}>
            {title}
          </Link>
        ) : (
          <span className="plan-entry-title">{title}</span>
        )}
        {isRecipe ? (
          <div className="plan-entry-servings">
            <Stepper
              formatValue={(value) => String(value)}
              label={`Servings for ${title}`}
              max={99}
              min={1}
              onChange={(value) => onServingsChange(entry, value)}
              size="sm"
              value={servings ?? 4}
            />
            <span aria-hidden="true" className="plan-entry-servings-label">
              <Icon className="plan-entry-servings-icon" name="users" size={14} />
              <span className="plan-entry-servings-word">
                {servings === 1 ? "serving" : "servings"}
              </span>
            </span>
          </div>
        ) : null}
      </div>
      <div className="plan-entry-menu">
        <Menu
          items={menuItems}
          label={`Options for ${title}`}
          renderTrigger={(props) => (
            <IconButton
              aria-label={`Options for ${title}`}
              icon="more-vertical"
              size="sm"
              {...props}
            />
          )}
        />
      </div>
    </li>
  );
};

export const PlanEntryCard = memo(PlanEntryCardComponent);
