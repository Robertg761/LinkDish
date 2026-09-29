import React, { memo } from "react";
import { Link } from "react-router-dom";

import { RecipeImage } from "./RecipeImage";

import type { RecipeImage as RecipeImageData } from "@linkdish/recipe-domain";

import "./RecipeCard.css";

export interface RecipeCardProps {
  to: string;
  title: string;
  /** Rich title content (e.g. search highlights). `title` still names the image fallback. */
  titleContent?: React.ReactNode;
  image?: RecipeImageData | null | undefined;
  /** One quiet line: "4 servings · 35 min · seriouseats.com". */
  meta?: React.ReactNode;
  variant?: "grid" | "list" | undefined;
  /** Small chips/badges under the title. */
  badges?: React.ReactNode;
  /** A favorite toggle (IconButton) pinned to the photo's corner on grid cards. */
  favoriteSlot?: React.ReactNode;
  /** Trailing actions: at the end of list rows, beside the meta line on grid cards. */
  actionsSlot?: React.ReactNode;
  /** Small status badges laid over the photo's top-left corner on grid cards. */
  mediaBadges?: React.ReactNode;
  /** Eager-load the image (first cards above the fold). */
  priority?: boolean | undefined;
  /** The image's `sizes` when the card is not in a page grid (a shelf's fixed-width track). */
  imageSizes?: string | undefined;
  /** Router state passed with the link. */
  state?: unknown;
  onNavigate?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * A grid card's photo width: 4 columns from 1280px (at most 240px wide), 3 from 600px (beside the
 * 248px side rail from 1024px) and 2 on phones. Phones say 160px, a little under the ~175px a
 * card really is: the proxy's 480 rendition is sharp there even at 3x (it is scaled up under
 * 10%), and at 3x the true width would pick the 1200 one, about four times the bytes.
 */
const GRID_SIZES =
  "(min-width: 1280px) 240px, (min-width: 1024px) calc(33vw - 120px), (min-width: 600px) calc(33vw - 24px), 160px";

/**
 * Recipe tile for grids and lists. The whole card is one link (stretched over the
 * card), while favorite/overflow slots stay separate buttons on top of it.
 */
const RecipeCardComponent: React.FC<RecipeCardProps> = ({
  to,
  title,
  titleContent,
  image,
  meta,
  variant = "grid",
  badges,
  favoriteSlot,
  actionsSlot,
  mediaBadges,
  priority = false,
  imageSizes,
  state,
  onNavigate,
  className = ""
}) => {
  const isList = variant === "list";

  return (
    <article
      className={[
        "recipe-card",
        `recipe-card-${variant}`,
        !isList && actionsSlot ? "recipe-card-has-actions" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="recipe-card-media">
        <RecipeImage
          aspectRatio={isList ? "1" : "4 / 3"}
          image={image}
          priority={priority}
          sizes={isList ? "72px" : (imageSizes ?? GRID_SIZES)}
          title={title}
          widths={isList ? [96, 480] : [480, 1200]}
        />
        {favoriteSlot && !isList ? (
          <div className="recipe-card-favorite">{favoriteSlot}</div>
        ) : null}
        {mediaBadges && !isList ? (
          <div className="recipe-card-media-badges">{mediaBadges}</div>
        ) : null}
      </div>
      <div className="recipe-card-body">
        <h3 className="recipe-card-title">
          <Link className="recipe-card-link" onClick={onNavigate} state={state} to={to}>
            {titleContent ?? title}
          </Link>
        </h3>
        {meta ? <p className="recipe-card-meta">{meta}</p> : null}
        {badges ? <div className="recipe-card-badges">{badges}</div> : null}
      </div>
      {isList && (favoriteSlot || actionsSlot) ? (
        <div className="recipe-card-actions">
          {favoriteSlot}
          {actionsSlot}
        </div>
      ) : null}
      {!isList && actionsSlot ? <div className="recipe-card-actions">{actionsSlot}</div> : null}
    </article>
  );
};

export const RecipeCard = memo(RecipeCardComponent);
