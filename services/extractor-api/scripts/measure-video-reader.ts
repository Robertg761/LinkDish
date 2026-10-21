/*
 * Measures the video recipe reader on real videos, without the rest of /extract.
 *
 *   GEMINI_API_KEY=... pnpm --filter @linkdish/extractor-api exec tsx scripts/measure-video-reader.ts \
 *     ../../docs/video-reader-testset.json results.json [--model gemini-3.8-flash]
 *
 * TikToks go the way /extract takes them: the caption is read first, and the video is watched
 * when the caption holds no full recipe. YouTube Shorts are passed by URL with the description
 * excerpt from the test set (the watch page is often bot-walled from servers). Every reading is
 * written to the results file with its rejections, latency and token use, for checking by hand
 * against the creator's written recipe.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { extractTextRecipe } from "../src/modules/extract/extractors/text/extract-text-recipe.js";
import { buildVideoRecipeCandidate } from "../src/modules/extract/extractors/video/build-video-recipe-candidate.js";
import { createGeminiVideoRecipeReader } from "../src/modules/extract/extractors/video/gemini-video-recipe-reader.js";
import { fetchTikTokDocument } from "../src/modules/extract/fetchers/fetch-tiktok-document.js";
import { fetchTikTokVideo } from "../src/modules/extract/fetchers/fetch-tiktok-video.js";
import {
  parseYouTubeVideoId,
  toYouTubeWatchUrl
} from "../src/modules/extract/source-detection/parse-youtube-video-id.js";

import type { VideoRecipeSource } from "../src/modules/extract/extractors/video/gemini-video-recipe-reader.js";
import type { VideoRecipeContext } from "../src/modules/extract/extractors/video/video-recipe-payload.js";

interface TestVideo {
  id: string;
  platform: "tiktok" | "youtube";
  url: string;
  creator: string;
  isRecipe: boolean;
  title?: string;
  captionExcerpt?: string;
}

const [manifestPath, outputPath, ...rest] = process.argv.slice(2);
const modelFlag = rest.indexOf("--model");
const model = modelFlag >= 0 ? rest[modelFlag + 1] : "gemini-3.8-flash";
const apiKey = process.env.GEMINI_API_KEY;

if (!manifestPath || !outputPath || !model || !apiKey) {
  console.error(
    "Usage: GEMINI_API_KEY=... tsx scripts/measure-video-reader.ts <manifest> <out> [--model id]"
  );
  process.exit(1);
}

const videos = JSON.parse(readFileSync(manifestPath, "utf8")) as TestVideo[];

/* A reader per video, whose fetch keeps Gemini's token counts (the reader does not return them). */
const createMeteredReader = () => {
  const metered = { usage: null as unknown };
  const meteredFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes(":generateContent") && response.ok) {
      metered.usage = (
        (await response.clone().json()) as { usageMetadata?: unknown }
      ).usageMetadata;
    }

    return response;
  };
  const reader = createGeminiVideoRecipeReader({
    enabled: true,
    apiKey,
    model,
    fetchImplementation: meteredFetch,
    timeoutMs: 90_000
  });

  return { reader, metered };
};

const measure = async (video: TestVideo) => {
  const startedAt = Date.now();
  const result: Record<string, unknown> = {
    id: video.id,
    platform: video.platform,
    isRecipe: video.isRecipe,
    url: video.url
  };

  try {
    let source: VideoRecipeSource;
    let context: VideoRecipeContext;
    let fallbackTitle: string;

    if (video.platform === "tiktok") {
      const document = await fetchTikTokDocument(video.url, fetch, { timeoutMs: 15_000 });
      const caption = extractTextRecipe(document);
      result.caption = caption
        ? caption.methodInVideo
          ? "ingredients_only"
          : "full_recipe"
        : "no_recipe";

      if (caption && !caption.methodInVideo) {
        result.outcome = "caption";
        result.recipe = caption.candidate.recipe;
        return result;
      }

      const downloadStartedAt = Date.now();
      const file = await fetchTikTokVideo(document.url, fetch, {
        timeoutMs: 20_000,
        maxBytes: 60 * 1024 * 1024,
        maxSeconds: 600
      });
      result.downloadMs = Date.now() - downloadStartedAt;
      result.videoBytes = file.bytes.byteLength;
      source = { kind: "file", bytes: file.bytes, mimeType: file.mimeType };
      context = {
        platform: "tiktok",
        caption: document.text || null,
        title: document.title,
        authorName: document.authorName
      };
      fallbackTitle = `TikTok recipe from ${document.authorName ?? video.creator}`;
    } else {
      const videoId = parseYouTubeVideoId(video.url);

      if (!videoId) {
        throw new Error("No YouTube video id.");
      }

      source = { kind: "youtube", url: toYouTubeWatchUrl(videoId) };
      context = {
        platform: "youtube",
        caption: video.captionExcerpt ?? null,
        title: video.title ?? null,
        authorName: video.creator
      };
      fallbackTitle = `YouTube recipe ${videoId}`;
    }

    const readStartedAt = Date.now();
    const { reader, metered } = createMeteredReader();
    const payload = await reader.read({ source, context });
    result.readMs = Date.now() - readStartedAt;
    result.usage = metered.usage;

    if (!payload) {
      result.outcome = "failed";
      return result;
    }

    const { candidate, rejections } = buildVideoRecipeCandidate(payload, {
      context,
      fallbackTitle,
      recipe: {}
    });

    result.outcome = candidate ? "read" : "no_recipe";
    result.rejections = rejections;
    result.payload = payload;
    result.recipe = candidate?.recipe ?? null;
    result.warnings = candidate?.warnings ?? [];
    return result;
  } catch (error) {
    result.outcome = "error";
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    result.totalMs = Date.now() - startedAt;
    console.error(`${video.id}: ${String(result.outcome)} (${String(result.totalMs)} ms)`);
  }
};

const results: Record<string, unknown>[] = [];
const concurrency = 3;

for (let index = 0; index < videos.length; index += concurrency) {
  results.push(...(await Promise.all(videos.slice(index, index + concurrency).map(measure))));
}

writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);

const count = (predicate: (entry: Record<string, unknown>) => boolean) =>
  results.filter(predicate).length;

console.log(
  JSON.stringify(
    {
      model,
      videos: results.length,
      recipes: count((entry) => entry.isRecipe === true),
      recipesRead: count(
        (entry) =>
          entry.isRecipe === true && (entry.outcome === "read" || entry.outcome === "caption")
      ),
      nonRecipesRejected: count(
        (entry) => entry.isRecipe === false && entry.outcome === "no_recipe"
      ),
      errors: count((entry) => entry.outcome === "error" || entry.outcome === "failed")
    },
    null,
    2
  )
);
