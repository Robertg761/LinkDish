import React, { useState } from "react";

import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";

import type { ExtractRecipeImage } from "@linkdish/api-contracts";

import "./SourceScans.css";

/** The original photos of an image-imported recipe, with a full-size viewer. */
export const SourceScans: React.FC<{ images: readonly ExtractRecipeImage[] | undefined }> = ({
  images
}) => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (!images?.length) {
    return null;
  }

  const openImage = openIndex == null ? undefined : images[openIndex];

  return (
    <section aria-labelledby="recipe-source-scans" className="recipe-panel source-scans print-hide">
      <h2 className="recipe-section-title" id="recipe-source-scans">
        <Icon name="images" size={18} /> Your photos
      </h2>
      <ul className="source-scans-grid">
        {images.map((image, index) => (
          <li key={`${image.mimeType}-${index}`}>
            <button
              aria-label={`View photo ${index + 1} of ${images.length}`}
              className="source-scans-thumb"
              onClick={() => setOpenIndex(index)}
              type="button"
            >
              <img alt="" decoding="async" loading="lazy" src={image.dataUrl} />
            </button>
          </li>
        ))}
      </ul>
      <Sheet
        onClose={() => setOpenIndex(null)}
        open={openImage != null}
        size="lg"
        title={`Photo ${(openIndex ?? 0) + 1} of ${images.length}`}
      >
        {openImage ? (
          <img
            alt={`Scanned recipe photo ${(openIndex ?? 0) + 1}`}
            className="source-scans-full"
            src={openImage.dataUrl}
          />
        ) : null}
      </Sheet>
    </section>
  );
};
