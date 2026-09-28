import { describe, expect, it } from "vitest";

import { detectSourceType } from "./detect-source-type";

describe("detectSourceType", () => {
  it("detects recipe webpages", () => {
    expect(detectSourceType("https://www.seriouseats.com/best-recipe").sourceType).toBe(
      "recipe-webpage"
    );
  });

  it("detects generic articles", () => {
    expect(detectSourceType("https://example.com/blog/cozy-soup").sourceType).toBe("article");
  });

  it("detects supported YouTube videos and marks other video URLs as unsupported media", () => {
    expect(detectSourceType("https://www.youtube.com/watch?v=abc123").sourceType).toBe("youtube");
    expect(detectSourceType("https://www.youtube.com/shorts/abc123").sourceType).toBe("youtube");
    expect(
      detectSourceType("https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share").sourceType
    ).toBe("youtube");
    expect(detectSourceType("https://www.youtube.com/embed/dQw4w9WgXcQ").sourceType).toBe(
      "youtube"
    );
    expect(detectSourceType("https://www.youtube.com/shorts/").sourceType).toBe("video");
    expect(detectSourceType("https://youtu.be/abc123").sourceType).toBe("youtube");
    expect(detectSourceType("https://vimeo.com/123456").sourceType).toBe("video");
  });

  it("does not classify lookalike hostnames as supported services", () => {
    expect(detectSourceType("https://youtube.com.example.test/watch?v=abc123").sourceType).toBe(
      "article"
    );
    expect(detectSourceType("https://vimeo.com.example.test/123456").sourceType).toBe("article");
    expect(detectSourceType("https://instagram.com.example.test/reel/abc123").sourceType).toBe(
      "article"
    );
  });

  it("marks unsupported social URLs as social", () => {
    expect(detectSourceType("https://www.instagram.com/reel/abc123").sourceType).toBe("social");
    expect(detectSourceType("https://www.instagram.com/reel/abc123").adapterKey).toBeNull();
  });

  it("maps TikTok onto the existing social type with its own adapter key", () => {
    const detection = detectSourceType("https://www.tiktok.com/@cook/video/7234567890123456789");

    expect(detection.sourceType).toBe("social");
    expect(detection.adapterKey).toBe("tiktok");
    expect(detectSourceType("https://vm.tiktok.com/ZMabc123/").adapterKey).toBe("tiktok");
    expect(detectSourceType("https://tiktok.com.example.test/@cook/video/1").sourceType).toBe(
      "article"
    );
  });

  it("marks Pinterest pins so their outbound link is followed", () => {
    expect(detectSourceType("https://www.pinterest.com/pin/123456789/").adapterKey).toBe(
      "pinterest"
    );
    expect(detectSourceType("https://www.pinterest.co.uk/pin/123456789/").adapterKey).toBe(
      "pinterest"
    );
    expect(detectSourceType("https://www.pinterest.com/cook/soups/").adapterKey).toBeNull();
  });

  it("upgrades recipe classification when fetched HTML contains recipe schema", () => {
    const detection = detectSourceType("https://example.com/blog/cozy-soup", {
      kind: "html",
      url: "https://example.com/blog/cozy-soup",
      finalUrl: "https://example.com/blog/cozy-soup",
      html: '<script type="application/ld+json">{"@type":"Recipe","name":"Soup"}</script>',
      contentType: "text/html",
      title: "Cozy Soup",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(detection.sourceType).toBe("recipe-webpage");
    expect(detection.confidence).toBe("high");
  });
});
