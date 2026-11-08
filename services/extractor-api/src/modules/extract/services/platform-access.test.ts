import { describe, expect, it, vi } from "vitest";

import { createMemoryCacheStore } from "../cache/cache-store";
import { createExtractionResultCache } from "../cache/extraction-cache";

import { extractRecipe } from "./extract-recipe";

import type { ExtractorRuntime, PlatformAccess } from "../types";

/*
 * Platform paths switched off by their env flags (each platform's terms, checked 2026-11-08) fail
 * before anything is fetched and before the shared cache is read. Every path is on by default
 * since Robert's 2026-11-08 decision; each flag still turns its own path off.
 */

const allOff: PlatformAccess = {
  facebook: false,
  instagram: false,
  pinterest: false,
  socialVideoDownload: false,
  tiktok: false,
  youtube: false
};

const createRuntime = (platformAccess: PlatformAccess | undefined) => {
  const fetchHtmlDocument = vi.fn<ExtractorRuntime["fetchHtmlDocument"]>(() =>
    Promise.reject(new Error("must not fetch"))
  );
  const fetchYouTubeDocument = vi.fn<ExtractorRuntime["fetchYouTubeDocument"]>(() =>
    Promise.reject(new Error("must not fetch"))
  );
  const fetchSocialDocument = vi.fn<NonNullable<ExtractorRuntime["fetchSocialDocument"]>>(() =>
    Promise.reject(new Error("must not fetch"))
  );
  const cacheStore = createMemoryCacheStore(50);
  const runtime: ExtractorRuntime = {
    fetchImplementation: fetch,
    fetchHtmlDocument,
    fetchYouTubeDocument,
    fetchSocialDocument,
    fallbackExtractor: { available: false, providerName: "none", extract: vi.fn() },
    extractionCache: createExtractionResultCache({ ttlSeconds: 600, store: cacheStore }),
    validateSourceUrl: vi.fn(() => Promise.resolve({ safe: true as const })),
    ...(platformAccess ? { platformAccess } : {}),
    dispose: () => Promise.resolve()
  };

  return { fetchHtmlDocument, fetchSocialDocument, fetchYouTubeDocument, runtime };
};

describe("platform paths switched off", () => {
  it.each([
    ["YouTube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", /YouTube videos/u],
    ["YouTube Shorts", "https://youtube.com/shorts/dQw4w9WgXcQ", /YouTube videos/u],
    ["Instagram", "https://www.instagram.com/p/C1a2b3c4d5e/", /Instagram posts/u],
    ["Facebook", "https://www.facebook.com/dinnerwithdana/posts/123456789", /Facebook posts/u],
    ["Pinterest", "https://www.pinterest.com/pin/123456789012345678/", /Pinterest pins/u],
    ["pin.it", "https://pin.it/abc123", /Pinterest pins/u],
    ["TikTok", "https://www.tiktok.com/@cook/video/7300000000000000000", /TikTok videos/u]
  ])("refuses a %s link without fetching anything", async (_label, url, message) => {
    const { fetchHtmlDocument, fetchSocialDocument, fetchYouTubeDocument, runtime } =
      createRuntime(allOff);

    const { response } = await extractRecipe({ url, attempt: "primary" }, runtime);

    expect(response).toMatchObject({ status: "failure", reason: "unsupported_source" });
    expect(response.status === "failure" ? response.userMessage : "").toMatch(message);
    expect(fetchHtmlDocument).not.toHaveBeenCalled();
    expect(fetchSocialDocument).not.toHaveBeenCalled();
    expect(fetchYouTubeDocument).not.toHaveBeenCalled();
  });

  it("points people at a way in that needs no automated reading", async () => {
    const { runtime } = createRuntime(allOff);

    const { response } = await extractRecipe(
      { url: "https://www.instagram.com/reel/C1a2b3c4d5e/", attempt: "primary" },
      runtime
    );

    expect(response.status === "failure" ? response.userMessage : "").toMatch(
      /Paste the recipe text or import a screenshot/u
    );
  });

  it("still reads an ordinary recipe web page", async () => {
    const { fetchHtmlDocument, runtime } = createRuntime(allOff);

    await extractRecipe({ url: "https://www.example.com/best-chili", attempt: "primary" }, runtime);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
  });

  it("lets a platform through when its flag is on", async () => {
    const { fetchYouTubeDocument, runtime } = createRuntime({ ...allOff, youtube: true });

    await extractRecipe(
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", attempt: "primary" },
      runtime
    );

    expect(fetchYouTubeDocument).toHaveBeenCalledTimes(1);
  });

  it("keeps every path open for runtimes without platformAccess (tests, local tools)", async () => {
    const { fetchYouTubeDocument, runtime } = createRuntime(undefined);

    await extractRecipe(
      { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", attempt: "primary" },
      runtime
    );

    expect(fetchYouTubeDocument).toHaveBeenCalledTimes(1);
  });
});

describe("default platform flags", () => {
  it("turn every platform path and the video reader on, and keep robots.txt on", async () => {
    const { extractorApiEnv } = await import("../../../config/env");

    // These are the shipped defaults unless the environment overrides them.
    if (
      process.env.YOUTUBE_IMPORT_ENABLED === undefined &&
      process.env.INSTAGRAM_IMPORT_ENABLED === undefined &&
      process.env.FACEBOOK_IMPORT_ENABLED === undefined &&
      process.env.PINTEREST_IMPORT_ENABLED === undefined &&
      process.env.SOCIAL_VIDEO_DOWNLOAD_ENABLED === undefined &&
      process.env.VIDEO_RECIPE_READER_ENABLED === undefined &&
      process.env.ROBOTS_TXT_ENFORCED === undefined
    ) {
      // Robert turned every platform path back on by default on 2026-11-08, accepting the risk.
      expect(extractorApiEnv.YOUTUBE_IMPORT_ENABLED).toBe(true);
      expect(extractorApiEnv.INSTAGRAM_IMPORT_ENABLED).toBe(true);
      expect(extractorApiEnv.FACEBOOK_IMPORT_ENABLED).toBe(true);
      expect(extractorApiEnv.PINTEREST_IMPORT_ENABLED).toBe(true);
      expect(extractorApiEnv.SOCIAL_VIDEO_DOWNLOAD_ENABLED).toBe(true);
      // Video downloads only feed the reader, so it is on too (still needs GEMINI_API_KEY).
      expect(extractorApiEnv.VIDEO_RECIPE_READER_ENABLED).toBe(true);
      expect(extractorApiEnv.ROBOTS_TXT_ENFORCED).toBe(true);
    }
  });
});

describe("social video downloads (Apple guideline 5.2.3)", () => {
  it("are not wired into the default runtime while SOCIAL_VIDEO_DOWNLOAD_ENABLED is off", async () => {
    const { extractorApiEnv } = await import("../../../config/env");
    const { createDefaultExtractorRuntime } = await import("./runtime");
    const original = extractorApiEnv.SOCIAL_VIDEO_DOWNLOAD_ENABLED;

    try {
      extractorApiEnv.SOCIAL_VIDEO_DOWNLOAD_ENABLED = false;
      const off = createDefaultExtractorRuntime();
      expect(off.fetchSocialVideo).toBeUndefined();
      expect(off.fetchFacebookVideo).toBeUndefined();
      expect(off.platformAccess?.socialVideoDownload).toBe(false);

      extractorApiEnv.SOCIAL_VIDEO_DOWNLOAD_ENABLED = true;
      const on = createDefaultExtractorRuntime();
      expect(on.fetchSocialVideo).toBeTypeOf("function");
      expect(on.fetchFacebookVideo).toBeTypeOf("function");
    } finally {
      extractorApiEnv.SOCIAL_VIDEO_DOWNLOAD_ENABLED = original;
    }
  });
});
