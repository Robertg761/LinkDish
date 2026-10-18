import { toYouTubeWatchUrl } from "../../source-detection/parse-youtube-video-id.js";
import {
  buildTextRecipeCandidate,
  isCompleteRecipeParse,
  type TextRecipeExtraction
} from "../text/extract-text-recipe.js";
import { findTextLinks, parseRecipeText } from "../text/parse-recipe-text.js";

import type { YouTubeSourceDocument } from "../../types.js";

/*
 * A YouTube recipe is read from what the creator wrote: the description (or, where the server
 * can get one, a transcript that happens to be laid out as a recipe). Spoken transcripts are
 * not turned into recipes; a video whose description has no recipe is reported as such, and
 * the caller can follow a "full recipe" link instead (see findYouTubeRecipeLinks).
 */
export const extractYouTubeRecipe = (
  document: YouTubeSourceDocument
): TextRecipeExtraction | null => {
  const descriptionParse = parseRecipeText(document.description ?? "");
  const transcriptParse = document.transcript ? parseRecipeText(document.transcript) : null;
  const usesTranscript =
    transcriptParse !== null &&
    isCompleteRecipeParse(transcriptParse) &&
    !isCompleteRecipeParse(descriptionParse);
  const parsed = usesTranscript ? transcriptParse : descriptionParse;
  const provenance = usesTranscript ? "transcript" : "visible-text";

  return buildTextRecipeCandidate(parsed, {
    sourceTitle: document.title,
    fallbackTitle: `YouTube recipe ${document.videoId}`,
    isVideo: true,
    strategy: "youtube-transcript",
    provenance,
    recipe: {
      sourceUrl: document.url,
      sourceType: "youtube",
      image: {
        source: "youtube-thumb",
        url: `https://i.ytimg.com/vi/${encodeURIComponent(document.videoId)}/hqdefault.jpg`
      },
      siteName: "YouTube",
      videoUrl: toYouTubeWatchUrl(document.videoId),
      ...(document.authorName ? { author: document.authorName } : {})
    }
  });
};

/* Hosts that never carry the written recipe: socials, shops, music, link hubs. */
const nonRecipeHostPattern =
  /(?:^|\.)(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.com|fb\.me|tiktok\.com|twitter\.com|x\.com|threads\.net|pinterest\.[a-z.]+|pin\.it|patreon\.com|amazon\.[a-z.]+|amzn\.[a-z]+|amzn\.to|linktr\.ee|beacons\.ai|spotify\.com|apple\.com|music\.apple\.com|soundcloud\.com|discord\.gg|discord\.com|twitch\.tv|snapchat\.com|reddit\.com|ko-fi\.com|buymeacoffee\.com|paypal\.me|paypal\.com|etsy\.com|shopify\.com|teespring\.com|spreadshirt\.[a-z.]+|epidemicsound\.com|artlist\.io|google\.com|goo\.gl|forms\.gle|wa\.me|t\.me|whatsapp\.com)$/iu;
/* "Full recipe:", "Get the recipe here", "Printable recipe & measurements". */
const strongRecipeCuePattern =
  /\b(?:full|written|printable|complete|detailed|exact)\s+recipe\b|\brecipe\s*(?:here|link|[:👉⬇↓])|\bget the recipe\b|\b(?:measurements|ingredients list)\b/iu;
const recipeCuePattern =
  /\b(?:recipes?|written|printable|ingredients|measurements|method|blog)\b/iu;

const maxRecipeLinks = 2;

/**
 * Links in a video's description that likely lead to its written recipe, best first: links on
 * (or right under) a line like "Full recipe:", then lines that mention a recipe, then links
 * whose path says "recipe". Home pages and social, shop and music links are left out.
 */
export const findYouTubeRecipeLinks = (document: YouTubeSourceDocument): string[] => {
  const ranked = findTextLinks(document.description ?? "")
    .map(({ url, line }, order) => {
      let parsed: URL;

      try {
        parsed = new URL(url);
      } catch {
        return null;
      }

      if (
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        nonRecipeHostPattern.test(parsed.hostname)
      ) {
        return null;
      }

      const tier = strongRecipeCuePattern.test(line)
        ? 0
        : recipeCuePattern.test(line)
          ? 1
          : /recipe/iu.test(parsed.pathname)
            ? 2
            : null;
      /* "https://blog.example/?p=123" and "https://cook.example/#/recipes/1" are recipe permalinks. */
      const isHomePage =
        parsed.pathname.replace(/\/+$/u, "") === "" && parsed.search === "" && parsed.hash === "";

      if (isHomePage || tier === null) {
        return null;
      }

      return { url: parsed.toString(), rank: tier * 1000 + order };
    })
    .filter((entry): entry is { url: string; rank: number } => entry !== null)
    .sort((left, right) => left.rank - right.rank);

  return [...new Set(ranked.map((entry) => entry.url))].slice(0, maxRecipeLinks);
};
