import { looksLikeShellHtml, looksLikeThinHtml } from "../html/page-signals.js";
import { hasUsableRecipeStructuredData } from "../source-detection/structured-data-hints.js";

import type { HtmlSourceDocument } from "../types.js";

/**
 * Decides whether an HTTP-fetched page should be re-rendered with Playwright:
 * only when a browser is available, the page has no usable Recipe structured
 * data, and it is blocked, a JavaScript shell or nearly empty. Passing the
 * fetched `document` reuses its shared parse instead of parsing `html` again.
 */
export const shouldUseBrowserFallback = ({
  available,
  blockedSignals,
  html,
  document
}: {
  available: boolean;
  blockedSignals: string[];
  html: string;
  document?: HtmlSourceDocument;
}): boolean => {
  if (!available || hasUsableRecipeStructuredData(html)) {
    return false;
  }

  const source = document?.html === html ? document : html;

  return blockedSignals.length > 0 || looksLikeShellHtml(source) || looksLikeThinHtml(source);
};
