import React, { useEffect, useState } from "react";

import { EXTRACTION_LOADING_COPY } from "./extraction-loading-copy";

const EXTRACTION_COPY_ROTATION_MS = 1800;

export const ExtractionLoadingCopy: React.FC = () => {
  const [copyIndex, setCopyIndex] = useState(0);
  const [exitingCopyIndex, setExitingCopyIndex] = useState<number | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setCopyIndex((currentIndex) => {
        setExitingCopyIndex(currentIndex);
        return (currentIndex + 1) % EXTRACTION_LOADING_COPY.length;
      });
    }, EXTRACTION_COPY_ROTATION_MS);

    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <span className="extraction-loading-copy">
      {exitingCopyIndex !== null ? (
        <span
          aria-hidden="true"
          className="extraction-loading-copy-line is-exiting"
          key={`exiting-${exitingCopyIndex}`}
        >
          {EXTRACTION_LOADING_COPY[exitingCopyIndex]}
        </span>
      ) : null}
      <span className="extraction-loading-copy-line is-entering" key={`entering-${copyIndex}`}>
        {EXTRACTION_LOADING_COPY[copyIndex]}
      </span>
    </span>
  );
};
