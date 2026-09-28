import React from "react";

import { Icon } from "../../components/Icon";
import { RecipeImage } from "../../components/RecipeImage";

import { formatCookedLine, getRecipeMetaItems } from "./recipe-view-format";

import type { RecipeSourceInfo } from "./recipe-source";
import type { IconName } from "../../components/Icon";
import type { RecipeRating } from "../library/saved-recipe-types";
import type { Recipe, RecipeCourse } from "@linkdish/recipe-domain";

import "./RecipeHero.css";

const META_ICONS: Record<string, IconName> = {
  cook: "flame",
  prep: "utensils",
  serves: "users",
  total: "clock"
};

export const RecipeSourceChip: React.FC<{ source: RecipeSourceInfo }> = ({ source }) => {
  const icon: IconName =
    source.kind === "photos"
      ? "camera"
      : source.kind === "starter"
        ? "chef-hat"
        : source.kind === "text"
          ? "file-text"
          : source.kind === "imported"
            ? "download"
            : "globe";
  const content = (
    <>
      <Icon name={icon} size={15} />
      <span className="recipe-source-chip-label">{source.label}</span>
      {source.href ? (
        <Icon className="recipe-source-chip-external" name="arrow-up-right" size={14} />
      ) : null}
    </>
  );

  return source.href ? (
    <a
      aria-label={`Open the original recipe on ${source.label}`}
      className="recipe-source-chip is-link"
      href={source.href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    <span className="recipe-source-chip">{content}</span>
  );
};

interface RatingStarsProps {
  value: RecipeRating | null | undefined;
  onChange?: ((rating: RecipeRating | null) => void) | undefined;
  size?: number | undefined;
  label?: string | undefined;
  className?: string | undefined;
}

/** Five stars: read-only, or a radiogroup where tapping the current star clears the rating. */
export const RatingStars: React.FC<RatingStarsProps> = ({
  value,
  onChange,
  size = 18,
  label = "Your rating",
  className = ""
}) => {
  const stars = [1, 2, 3, 4, 5] as const;
  const current = value ?? 0;

  if (!onChange) {
    return current > 0 ? (
      <span
        aria-label={`Rated ${current} out of 5`}
        className={`rating-stars is-readonly ${className}`}
        role="img"
      >
        {stars.map((star) => (
          <Icon
            key={star}
            name={star <= current ? "star-filled" : "star"}
            size={size}
            strokeWidth={1.8}
          />
        ))}
      </span>
    ) : null;
  }

  return (
    <span aria-label={label} className={`rating-stars ${className}`} role="radiogroup">
      {stars.map((star) => (
        <button
          aria-checked={current === star}
          aria-label={`${star} star${star === 1 ? "" : "s"}`}
          className={`rating-star${star <= current ? " is-filled" : ""}`}
          key={star}
          onClick={() => onChange(current === star ? null : star)}
          role="radio"
          type="button"
        >
          <Icon name={star <= current ? "star-filled" : "star"} size={size} strokeWidth={1.8} />
        </button>
      ))}
    </span>
  );
};

interface RecipeHeroProps {
  recipe: Pick<
    Recipe,
    "title" | "image" | "description" | "prepTimeMinutes" | "cookTimeMinutes" | "totalTimeMinutes"
  >;
  source: RecipeSourceInfo;
  /** Current (scaled) yield, e.g. "Serves 8". */
  servingsLabel: string;
  tags?: readonly string[] | undefined;
  rating?: RecipeRating | null | undefined;
  onRate?: ((rating: RecipeRating | null) => void) | undefined;
  timesCooked?: number | undefined;
  lastCookedAt?: string | undefined;
  /** Small line above the title (e.g. a household owner or a status chip). */
  eyebrow?: React.ReactNode;
  /** Primary actions under the meta strip (desktop). */
  actions?: React.ReactNode;
  titleId?: string | undefined;
  /** The recipe's course, for the no-photo cover's art. */
  course?: RecipeCourse | null | undefined;
}

/**
 * Photo-forward recipe header. Phones: a full-bleed 16:10 photo with a rounded bottom edge, then
 * the title block. From 1024px: an editorial split with the text beside the photo. Without a
 * photo the same band holds a designed cover (a plate with a course mark), a little shorter, so
 * the title never sits on top of artwork.
 */
export const RecipeHero: React.FC<RecipeHeroProps> = ({
  recipe,
  source,
  servingsLabel,
  tags,
  rating,
  onRate,
  timesCooked,
  lastCookedAt,
  eyebrow,
  actions,
  titleId,
  course
}) => {
  const hasImage = Boolean(recipe.image?.url);
  const metaItems = getRecipeMetaItems(recipe, servingsLabel);
  const cookedLine = formatCookedLine(timesCooked, lastCookedAt);
  const showRatingRow = Boolean(onRate) || (rating ?? 0) > 0 || cookedLine;

  return (
    <header className={`recipe-hero ${hasImage ? "has-image" : "has-cover"}`}>
      <div className="recipe-hero-media">
        <RecipeImage
          aspectRatio="auto"
          className="recipe-hero-image"
          course={course}
          image={recipe.image}
          priority
          sizes="(min-width: 1024px) 560px, (min-width: 768px) 720px, 100vw"
          title={recipe.title}
        />
      </div>

      <div className="recipe-hero-content">
        <div className="recipe-hero-eyebrow">
          <RecipeSourceChip source={source} />
          {eyebrow}
        </div>
        <h1 className="recipe-hero-title" id={titleId}>
          {recipe.title}
        </h1>
        {recipe.description ? (
          <p className="recipe-hero-description">{recipe.description}</p>
        ) : null}

        {metaItems.length > 0 ? (
          <dl className="recipe-hero-meta">
            {metaItems.map((item) => (
              <div className={`recipe-hero-meta-item is-${item.id}`} key={item.id}>
                <dt>
                  <Icon
                    name={
                      item.id === "serves" && item.label !== "Serves"
                        ? "chef-hat"
                        : (META_ICONS[item.id] ?? "clock")
                    }
                    size={16}
                  />
                  <span className="recipe-hero-meta-label">{item.label}</span>
                </dt>
                <dd className="num">
                  {item.spokenValue ? (
                    <>
                      <span aria-hidden="true">{item.value}</span>
                      <span className="sr-only">{item.spokenValue}</span>
                    </>
                  ) : (
                    item.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {tags && tags.length > 0 ? (
          <ul aria-label="Tags" className="recipe-hero-tags">
            {tags.map((tag) => (
              <li className="recipe-hero-tag" key={tag}>
                {tag}
              </li>
            ))}
          </ul>
        ) : null}

        {showRatingRow ? (
          <div className="recipe-hero-rating print-hide">
            <RatingStars onChange={onRate} value={rating} />
            {cookedLine ? (
              <span className="recipe-hero-cooked num">{cookedLine}</span>
            ) : onRate && !rating ? (
              <span className="recipe-hero-cooked">Tap a star to rate it</span>
            ) : null}
          </div>
        ) : null}

        {actions ? <div className="recipe-hero-actions print-hide">{actions}</div> : null}
      </div>
    </header>
  );
};
