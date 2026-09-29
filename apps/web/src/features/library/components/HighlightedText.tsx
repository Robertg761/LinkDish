import React, { useMemo } from "react";

import type { HighlightRange } from "@linkdish/recipe-domain";

/** Finds the ranges to mark in a text (the search engine's `highlightRanges` for a query). */
export type TextHighlighter = (text: string) => HighlightRange[];

interface HighlightedTextProps {
  text: string;
  highlight: TextHighlighter;
}

/** Text with the words that match a search query wrapped in <mark>. */
export const HighlightedText: React.FC<HighlightedTextProps> = ({ text, highlight }) => {
  const parts = useMemo(() => {
    const ranges = highlight(text);

    if (ranges.length === 0) {
      return null;
    }

    const pieces: Array<{ key: string; text: string; marked: boolean }> = [];
    let cursor = 0;

    for (const range of ranges) {
      if (range.start > cursor) {
        pieces.push({ key: `t${cursor}`, marked: false, text: text.slice(cursor, range.start) });
      }

      pieces.push({
        key: `m${range.start}`,
        marked: true,
        text: text.slice(range.start, range.end)
      });
      cursor = range.end;
    }

    if (cursor < text.length) {
      pieces.push({ key: `t${cursor}`, marked: false, text: text.slice(cursor) });
    }

    return pieces;
  }, [highlight, text]);

  if (!parts) {
    return <>{text}</>;
  }

  return (
    <>
      {parts.map((part) =>
        part.marked ? (
          <mark className="library-highlight" key={part.key}>
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={part.key}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
};
