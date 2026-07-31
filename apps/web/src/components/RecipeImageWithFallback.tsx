import React, { useState } from "react";

interface RecipeImageWithFallbackProps {
  src: string;
  alt?: string;
  imageClassName: string;
  /** Rendered when the image fails to load; typically a monogram block. */
  fallback: React.ReactNode;
}

export const RecipeImageWithFallback: React.FC<RecipeImageWithFallbackProps> = ({
  src,
  alt = "",
  imageClassName,
  fallback
}) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <>{fallback}</>;
  }

  return (
    <img
      className={imageClassName}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
};
