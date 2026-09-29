import React, { useCallback, useEffect, useState } from "react";

import { buildRecipeImageUrl } from "../lib/recipe-image";

import { RecipeCover } from "./RecipeCover";

import type { RecipeImageWidth } from "../lib/recipe-image";
import type { RecipeCourse, RecipeImage as RecipeImageData } from "@linkdish/recipe-domain";

import "./RecipeImage.css";

const DEFAULT_WIDTHS: ReadonlyArray<RecipeImageWidth> = [96, 480, 1200];

export interface FadeImageProps {
  src: string;
  srcSet?: string | undefined;
  sizes?: string | undefined;
  alt?: string | undefined;
  className?: string | undefined;
  /** Above-the-fold hero: eager load with high fetch priority. */
  priority?: boolean | undefined;
  crossOrigin?: "anonymous" | undefined;
  onError?: (() => void) | undefined;
}

/**
 * An <img> that fades in once decoded. Lazy by default; `priority` switches to eager +
 * fetchpriority=high for the few images a screen opens on, and shows them the moment they are
 * decoded: no fade, and no wait for script to notice the load (it counts as painted, for Largest
 * Contentful Paint, only once visible).
 */
export const FadeImage: React.FC<FadeImageProps> = ({
  src,
  srcSet,
  sizes,
  alt = "",
  className = "",
  priority = false,
  crossOrigin,
  onError
}) => {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [src]);

  // Cached images can finish before React attaches onLoad.
  const handleRef = useCallback((element: HTMLImageElement | null) => {
    if (element?.complete && element.naturalWidth > 0) {
      setLoaded(true);
    }
  }, []);

  return (
    <img
      alt={alt}
      className={[priority ? "" : "fade-image", loaded ? "is-loaded" : "", className]
        .filter(Boolean)
        .join(" ")}
      crossOrigin={crossOrigin}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      loading={priority ? "eager" : "lazy"}
      onError={onError}
      onLoad={() => setLoaded(true)}
      ref={handleRef}
      sizes={srcSet ? sizes : undefined}
      src={src}
      srcSet={srcSet}
    />
  );
};

export interface RecipeImageProps {
  image: RecipeImageData | null | undefined;
  /** Recipe title: picks the no-photo cover's art (a course-appropriate plate). */
  title: string;
  /** The recipe's course when known (from the whole recipe); otherwise read from the title. */
  course?: RecipeCourse | null | undefined;
  /** Empty by default: the title is almost always visible right next to the photo. */
  alt?: string | undefined;
  /** The `sizes` attribute, e.g. "(min-width: 1024px) 280px, 50vw". */
  sizes?: string | undefined;
  /** CSS aspect-ratio of the box, e.g. "4 / 3", "1", "16 / 9". Use "auto" to size by CSS. */
  aspectRatio?: string | undefined;
  priority?: boolean | undefined;
  widths?: ReadonlyArray<RecipeImageWidth> | undefined;
  /** Replaces the designed cover when there is no photo. */
  fallback?: React.ReactNode;
  className?: string | undefined;
  crossOrigin?: "anonymous" | undefined;
}

/**
 * Photo-forward recipe image through the image proxy: a srcset over the proxy widths
 * (96/480/1200), a reserved aspect-ratio box with a warm placeholder tint, a fade-in,
 * and a designed cover (a plate with a course mark on gingham) when there is no photo or it
 * fails to load.
 */
export const RecipeImage: React.FC<RecipeImageProps> = ({
  image,
  title,
  course,
  alt = "",
  sizes = "(min-width: 1024px) 400px, 100vw",
  aspectRatio = "4 / 3",
  priority = false,
  widths = DEFAULT_WIDTHS,
  fallback,
  className = "",
  crossOrigin
}) => {
  const [failed, setFailed] = useState(false);
  const imageUrl = image?.url ?? null;

  useEffect(() => {
    setFailed(false);
  }, [imageUrl]);

  const sortedWidths = [...widths].sort((left, right) => left - right);
  const defaultWidth = sortedWidths.includes(480)
    ? 480
    : (sortedWidths[sortedWidths.length - 1] ?? 480);
  const src = buildRecipeImageUrl(image, defaultWidth);
  const srcSet = sortedWidths
    .map((width) => {
      const url = buildRecipeImageUrl(image, width);
      return url ? `${url} ${width}w` : null;
    })
    .filter(Boolean)
    .join(", ");
  const showFallback = !src || failed;

  return (
    <div
      className={["recipe-image", showFallback ? "is-fallback" : "", className]
        .filter(Boolean)
        .join(" ")}
      data-testid="recipe-image"
      style={aspectRatio === "auto" ? undefined : { aspectRatio }}
    >
      {showFallback ? (
        (fallback ?? <RecipeCover course={course} title={title} />)
      ) : (
        <FadeImage
          alt={alt}
          className="recipe-image-img"
          crossOrigin={crossOrigin}
          onError={() => setFailed(true)}
          priority={priority}
          sizes={sizes}
          src={src}
          srcSet={srcSet || undefined}
        />
      )}
    </div>
  );
};
