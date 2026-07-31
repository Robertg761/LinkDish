import { load } from "cheerio";

import { getDomainAdapter } from "./domain-adapters.js";
import { parseYouTubeVideoId } from "./parse-youtube-video-id.js";

import type { DetectionResult, HtmlSourceDocument } from "../types.js";

const socialHosts = ["instagram.com", "tiktok.com", "facebook.com"];
const videoHosts = ["vimeo.com", "dailymotion.com", "twitch.tv"];

const hasRecipeJsonLd = (html: string): boolean =>
  /"@type"\s*:\s*(?:"Recipe"|\[[^\]]*"Recipe")/i.test(html);
const hasRecipeMicrodata = (html: string): boolean => /itemtype\s*=\s*["'][^"']*Recipe/i.test(html);

export const hasUsableRecipeStructuredData = (html: string): boolean =>
  (hasRecipeJsonLd(html) &&
    /"recipeIngredient"\s*:\s*\[\s*(?:"|\{)/i.test(html) &&
    /"recipeInstructions"\s*:\s*(?:\[\s*(?:"|\{)|"(?:[^"\\]|\\.)+")/i.test(html)) ||
  (hasRecipeMicrodata(html) &&
    /itemprop\s*=\s*["'][^"']*recipeIngredient/i.test(html) &&
    /itemprop\s*=\s*["'][^"']*recipeInstructions/i.test(html));

const hasStrongRecipeDomSignals = (document: HtmlSourceDocument): boolean => {
  const $ = load(document.html);
  const hostname = new URL(document.finalUrl).hostname.toLowerCase();
  const adapter = getDomainAdapter(hostname);
  const selectors = adapter?.selectors;

  const selectorIngredientCount = selectors
    ? selectors.ingredients.reduce((count, selector) => count + $(selector).length, 0)
    : 0;
  const selectorStepCount = selectors
    ? selectors.steps.reduce((count, selector) => count + $(selector).length, 0)
    : 0;
  const genericIngredientCount = $("h2, h3, strong")
    .toArray()
    .filter((node) => /ingredients?/i.test($(node).text())).length;
  const genericStepCount = $("h2, h3, strong")
    .toArray()
    .filter((node) => /(instructions?|directions?|method|steps?)/i.test($(node).text())).length;

  return (
    selectorIngredientCount > 0 ||
    selectorStepCount > 0 ||
    genericIngredientCount + genericStepCount >= 2
  );
};

export const detectSourceType = (url: string, document?: HtmlSourceDocument): DetectionResult => {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();
  const adapter = getDomainAdapter(hostname);

  if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) {
    if (pathname.startsWith("/shorts/")) {
      return {
        sourceType: "video",
        confidence: "high",
        reasons: ["Matched unsupported video hostname."],
        adapterKey: null
      };
    }

    if (parseYouTubeVideoId(url)) {
      return {
        sourceType: "youtube",
        confidence: "high",
        reasons: ["Matched supported YouTube video URL."],
        adapterKey: null
      };
    }

    return {
      sourceType: "video",
      confidence: "high",
      reasons: ["Matched unsupported video hostname."],
      adapterKey: null
    };
  }

  if (videoHosts.some((candidate) => hostname.includes(candidate))) {
    return {
      sourceType: "video",
      confidence: "high",
      reasons: ["Matched unsupported video hostname."],
      adapterKey: null
    };
  }

  if (socialHosts.some((candidate) => hostname.includes(candidate))) {
    return {
      sourceType: "social",
      confidence: "high",
      reasons: ["Matched unsupported social hostname."],
      adapterKey: null
    };
  }

  if (document) {
    if (hasRecipeJsonLd(document.html)) {
      return {
        sourceType: "recipe-webpage",
        confidence: "high",
        reasons: ["Detected Recipe JSON-LD in fetched HTML."],
        adapterKey: adapter?.key ?? null
      };
    }

    if (hasRecipeMicrodata(document.html)) {
      return {
        sourceType: "recipe-webpage",
        confidence: "high",
        reasons: ["Detected recipe microdata in fetched HTML."],
        adapterKey: adapter?.key ?? null
      };
    }

    if (hasStrongRecipeDomSignals(document)) {
      return {
        sourceType: "recipe-webpage",
        confidence: "medium",
        reasons: ["Detected strong recipe-like DOM structure in fetched HTML."],
        adapterKey: adapter?.key ?? null
      };
    }
  }

  if (adapter?.articlePathPatterns.some((pattern) => pattern.test(pathname))) {
    return {
      sourceType: "article",
      confidence: "high",
      reasons: ["Matched known article path pattern."],
      adapterKey: adapter.key
    };
  }

  if (
    adapter?.recipePathPatterns.some((pattern) => pattern.test(pathname)) ||
    hostname.includes("recipe") ||
    hostname.includes("food") ||
    hostname.includes("kitchen") ||
    pathname.includes("recipe")
  ) {
    return {
      sourceType: "recipe-webpage",
      confidence: "medium",
      reasons: ["Matched recipe-oriented URL heuristics."],
      adapterKey: adapter?.key ?? null
    };
  }

  return {
    sourceType: "article",
    confidence: "low",
    reasons: ["Fell back to article classification after URL heuristics."],
    adapterKey: adapter?.key ?? null
  };
};
