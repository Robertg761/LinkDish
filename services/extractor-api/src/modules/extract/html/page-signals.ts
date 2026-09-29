import { looksLikeNotFoundTitle } from "../fetchers/shared.js";
import { getDomainAdapter } from "../source-detection/domain-adapters.js";

import { getParsedHtmlDocument, type ParsedHtmlDocument } from "./parsed-html-document.js";

import type { HtmlSourceDocument } from "../types.js";

type HtmlSource = HtmlSourceDocument | ParsedHtmlDocument | string;

export const looksLikeShellHtml = (source: HtmlSource): boolean => {
  const parsed = getParsedHtmlDocument(source);
  const rootMarkerCount = parsed.$("#__next, #root, #app, [data-reactroot], [id*='app']").length;
  const scriptCount = parsed.$("script").length;

  return parsed.bodyText.length < 180 && rootMarkerCount > 0 && scriptCount > 8;
};

export const looksLikeThinHtml = (source: HtmlSource): boolean => {
  const parsed = getParsedHtmlDocument(source);

  return parsed.bodyText.length < 100 && parsed.html.replace(/\s+/g, "").length < 1500;
};

export const looksLikeNotFoundHtml = (source: HtmlSource): boolean => {
  const parsed = getParsedHtmlDocument(source);

  return (
    looksLikeNotFoundTitle(parsed.titleText.trim()) ||
    looksLikeNotFoundTitle(parsed.firstHeadingText.trim())
  );
};

export const hasStrongRecipeDomSignals = (document: HtmlSourceDocument): boolean => {
  const { $ } = getParsedHtmlDocument(document);
  const hostname = new URL(document.finalUrl).hostname.toLowerCase();
  const selectors = getDomainAdapter(hostname)?.selectors;

  const selectorIngredientCount = selectors
    ? selectors.ingredients.reduce((count, selector) => count + $(selector).length, 0)
    : 0;
  const selectorStepCount = selectors
    ? selectors.steps.reduce((count, selector) => count + $(selector).length, 0)
    : 0;
  const headingTexts = $("h2, h3, strong")
    .toArray()
    .map((node) => $(node).text());
  const genericIngredientCount = headingTexts.filter((text) => /ingredients?/i.test(text)).length;
  const genericStepCount = headingTexts.filter((text) =>
    /(instructions?|directions?|method|steps?)/i.test(text)
  ).length;

  return (
    selectorIngredientCount > 0 ||
    selectorStepCount > 0 ||
    genericIngredientCount + genericStepCount >= 2
  );
};
