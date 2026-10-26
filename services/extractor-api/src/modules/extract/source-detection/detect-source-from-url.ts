import { getDomainAdapter } from "./domain-adapters.js";
import { parseYouTubeVideoId } from "./parse-youtube-video-id.js";
import { getRegistrableDomain } from "./registrable-domain.js";

import type { DetectionResult } from "../types.js";

/*
 * URL-only source detection. The orchestrator needs it before anything is
 * fetched (unsupported social/video links are rejected up front), so it lives
 * apart from the document-aware detection and never loads the HTML parser.
 *
 * Response contracts validate sourceType against a closed enum in clients that
 * are already installed, so new platforms map onto existing values: TikTok and
 * Instagram are "social", other video hosts "video". The adapterKey tells the
 * orchestrator which platform path to take.
 */
const socialHosts = ["instagram.com", "instagr.am", "facebook.com", "fb.watch"];
const videoHosts = ["vimeo.com", "dailymotion.com", "twitch.tv"];
const matchesHostname = (hostname: string, expected: string): boolean =>
  hostname === expected || hostname.endsWith(`.${expected}`);

export const TIKTOK_ADAPTER_KEY = "tiktok";
export const PINTEREST_ADAPTER_KEY = "pinterest";
export const INSTAGRAM_ADAPTER_KEY = "instagram";

export const isTikTokUrl = (url: string): boolean => {
  try {
    return matchesHostname(new URL(url).hostname.toLowerCase(), "tiktok.com");
  } catch {
    return false;
  }
};

const isInstagramHostname = (hostname: string): boolean =>
  matchesHostname(hostname, "instagram.com") || matchesHostname(hostname, "instagr.am");

export const isInstagramUrl = (url: string): boolean => {
  try {
    return isInstagramHostname(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/*
 * A single Instagram post, reel or IGTV video: /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>,
 * also under a profile (/cook/p/<code>) as the share sheet sometimes writes them. Profiles,
 * stories and everything else are not posts.
 */
export const parseInstagramPost = (url: string): { shortcode: string; isVideo: boolean } | null => {
  try {
    const parsedUrl = new URL(url);

    if (!isInstagramHostname(parsedUrl.hostname.toLowerCase())) {
      return null;
    }

    const match = parsedUrl.pathname.match(
      /^\/(?:[\w.]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,64})\/?$/u
    );

    return match?.[1] && match[2] ? { shortcode: match[2], isVideo: match[1] !== "p" } : null;
  } catch {
    return null;
  }
};

/* pinterest.com, pinterest.ca, pinterest.co.uk, fr.pinterest.com... */
const isPinterestHostname = (hostname: string): boolean =>
  getRegistrableDomain(hostname).startsWith("pinterest.");

/** A Pinterest pin page (where the pin's outbound recipe link can be read). */
export const isPinterestPinUrl = (url: string): boolean => {
  try {
    const parsedUrl = new URL(url);
    return isPinterestHostname(parsedUrl.hostname) && /^\/pin\/[^/]+/u.test(parsedUrl.pathname);
  } catch {
    return false;
  }
};

export const isPinterestHostUrl = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return isPinterestHostname(hostname) || matchesHostname(hostname, "pinimg.com");
  } catch {
    return false;
  }
};

/** YouTube, other video hosts and social hosts, or null for everything else. */
export const detectHostedMediaSourceType = (url: string): DetectionResult | null => {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();

  if (matchesHostname(hostname, "youtube.com") || matchesHostname(hostname, "youtu.be")) {
    if (parseYouTubeVideoId(url)) {
      return {
        sourceType: "youtube",
        confidence: "high",
        reasons: [
          parsedUrl.pathname.toLowerCase().startsWith("/shorts/")
            ? "Matched supported YouTube Shorts URL."
            : "Matched supported YouTube video URL."
        ],
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

  if (matchesHostname(hostname, "tiktok.com")) {
    return {
      sourceType: "social",
      confidence: "high",
      reasons: ["Matched TikTok; the caption is read through TikTok's public oEmbed endpoint."],
      adapterKey: TIKTOK_ADAPTER_KEY
    };
  }

  if (parseInstagramPost(url)) {
    return {
      sourceType: "social",
      confidence: "high",
      reasons: ["Matched an Instagram post; the caption is read from its public embed page."],
      adapterKey: INSTAGRAM_ADAPTER_KEY
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

  if (isPinterestPinUrl(url)) {
    return {
      sourceType: "article",
      confidence: "low",
      reasons: ["Matched a Pinterest pin; its outbound recipe link is followed after fetching."],
      adapterKey: PINTEREST_ADAPTER_KEY
    };
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

export const detectSourceTypeFromUrl = (url: string): DetectionResult =>
  detectHostedMediaSourceType(url) ?? detectSourceTypeFromUrlPath(url);
