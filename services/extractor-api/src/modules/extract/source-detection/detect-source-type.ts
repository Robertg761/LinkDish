import { hasStrongRecipeDomSignals } from "../html/page-signals.js";

import {
  detectHostedMediaSourceType,
  detectSourceTypeFromUrlPath
} from "./detect-source-from-url.js";
import { getDomainAdapter } from "./domain-adapters.js";
import { hasRecipeJsonLd, hasRecipeMicrodata } from "./structured-data-hints.js";

import type { DetectionResult, HtmlSourceDocument } from "../types.js";

export { hasUsableRecipeStructuredData } from "./structured-data-hints.js";

const detectSourceTypeFromDocument = (
  url: string,
  document: HtmlSourceDocument
): DetectionResult | null => {
  const adapterKey = getDomainAdapter(new URL(url).hostname.toLowerCase())?.key ?? null;

  if (hasRecipeJsonLd(document.html)) {
    return {
      sourceType: "recipe-webpage",
      confidence: "high",
      reasons: ["Detected Recipe JSON-LD in fetched HTML."],
      adapterKey
    };
  }

  if (hasRecipeMicrodata(document.html)) {
    return {
      sourceType: "recipe-webpage",
      confidence: "high",
      reasons: ["Detected recipe microdata in fetched HTML."],
      adapterKey
    };
  }

  if (hasStrongRecipeDomSignals(document)) {
    return {
      sourceType: "recipe-webpage",
      confidence: "medium",
      reasons: ["Detected strong recipe-like DOM structure in fetched HTML."],
      adapterKey
    };
  }

  return null;
};

/**
 * URL classification refined by the fetched page (Recipe JSON-LD, microdata or
 * strong recipe DOM structure). The DOM checks reuse the document's shared parse.
 */
export const detectSourceType = (url: string, document?: HtmlSourceDocument): DetectionResult =>
  detectHostedMediaSourceType(url) ??
  (document ? detectSourceTypeFromDocument(url, document) : null) ??
  detectSourceTypeFromUrlPath(url);
