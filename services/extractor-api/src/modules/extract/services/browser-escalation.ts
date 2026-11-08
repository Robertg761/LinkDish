import { looksLikeShellHtml, looksLikeThinHtml } from "../html/page-signals.js";
import { hasUsableRecipeStructuredData } from "../source-detection/structured-data-hints.js";

import type { HtmlSourceDocument } from "../types.js";

/**
 * Decides whether an HTTP-fetched page should be re-rendered with Playwright: only when a
 * browser is available, the page has no usable Recipe structured data, and it is a JavaScript
 * shell or nearly empty, so its recipe only appears once scripts run.
 *
 * A page that blocked or challenged LinkDish (403/429, a CAPTCHA or bot wall: any blocked
 * signal) is never re-rendered. That is the site saying no to automated access, and a headless
 * browser must not be used to get past it (decided 2026-11-08; see
 * outputs/CONTENT-RIGHTS-REVIEW.md). The browser also identifies itself as LinkDishBot and obeys
 * robots.txt. Passing the fetched `document` reuses its shared parse instead of parsing `html`
 * again.
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
  if (!available || blockedSignals.length > 0 || hasUsableRecipeStructuredData(html)) {
    return false;
  }

  const source = document?.html === html ? document : html;

  return looksLikeShellHtml(source) || looksLikeThinHtml(source);
};
