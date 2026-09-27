import { useEffect } from "react";

export const APP_TITLE = "LinkDish";

export const formatDocumentTitle = (title: string | null | undefined): string => {
  const trimmed = title?.trim();

  return trimmed ? `${trimmed} · ${APP_TITLE}` : APP_TITLE;
};

/**
 * Sets document.title to "<title> · LinkDish" while mounted (and whenever the title
 * changes). Pass null/undefined while data loads to leave the route default alone.
 * The app shell sets a default per route; a page's own call runs later and wins.
 */
export const useDocumentTitle = (title: string | null | undefined): void => {
  useEffect(() => {
    if (title === null || title === undefined) {
      return;
    }

    document.title = formatDocumentTitle(title);
  }, [title]);
};
