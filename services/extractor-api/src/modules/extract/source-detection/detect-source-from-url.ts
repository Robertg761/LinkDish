import { getDomainAdapter } from "./domain-adapters.js";
import { parseYouTubeVideoId } from "./parse-youtube-video-id.js";

import type { DetectionResult } from "../types.js";

/*
 * URL-only source detection. The orchestrator needs it before anything is
 * fetched (unsupported social/video links are rejected up front), so it lives
 * apart from the document-aware detection and never loads the HTML parser.
 */
const socialHosts = ["instagram.com", "tiktok.com", "facebook.com"];
const videoHosts = ["vimeo.com", "dailymotion.com", "twitch.tv"];
const matchesHostname = (hostname: string, expected: string): boolean =>
  hostname === expected || hostname.endsWith(`.${expected}`);

/** YouTube, other video hosts and social hosts, or null for everything else. */
export const detectHostedMediaSourceType = (url: string): DetectionResult | null => {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();

  if (matchesHostname(hostname, "youtube.com") || matchesHostname(hostname, "youtu.be")) {
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

  if (videoHosts.some((candidate) => matchesHostname(hostname, candidate))) {
    return {
      sourceType: "video",
      confidence: "high",
      reasons: ["Matched unsupported video hostname."],
      adapterKey: null
    };
  }

  if (socialHosts.some((candidate) => matchesHostname(hostname, candidate))) {
    return {
      sourceType: "social",
      confidence: "high",
      reasons: ["Matched unsupported social hostname."],
      adapterKey: null
    };
  }

  return null;
};

/** Adapter path patterns and recipe-oriented URL keywords. */
export const detectSourceTypeFromUrlPath = (url: string): DetectionResult => {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();
  const adapter = getDomainAdapter(hostname);

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

export const detectSourceTypeFromUrl = (url: string): DetectionResult =>
  detectHostedMediaSourceType(url) ?? detectSourceTypeFromUrlPath(url);
