import React, { useEffect, useState } from "react";

import { FadeImage } from "./RecipeImage";

interface RecipeImageWithFallbackProps {
  src: string;
  alt?: string | undefined;
  imageClassName: string;
  /** Rendered when the image fails to load; typically a monogram block. */
  fallback: React.ReactNode;
  srcSet?: string | undefined;
  sizes?: string | undefined;
  /** Hero image: eager + fetchpriority=high. */
  priority?: boolean | undefined;
}

/**
 * Plain-src image with a fallback. Prefer <RecipeImage image={recipe.image} /> in new
 * code — it adds the proxy srcset, aspect-ratio box and monogram automatically.
 */
export const RecipeImageWithFallback: React.FC<RecipeImageWithFallbackProps> = ({
  src,
  alt = "",
  imageClassName,
  fallback,
  srcSet,
  sizes,
  priority = false
}) => {
  const [failed, setFailed] = useState(false);

  // A new source deserves a fresh attempt; otherwise the fallback sticks.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (failed) {
    return <>{fallback}</>;
  }

  return (
    <FadeImage
      alt={alt}
      className={imageClassName}
      onError={() => setFailed(true)}
      priority={priority}
      sizes={sizes}
      src={src}
      srcSet={srcSet}
    />
  );
};
