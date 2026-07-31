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
    expect(detectSourceType("https://www.youtube.com/shorts/abc123").sourceType).toBe("video");
    expect(detectSourceType("https://youtu.be/abc123").sourceType).toBe("youtube");
    expect(detectSourceType("https://vimeo.com/123456").sourceType).toBe("video");
  });

  it("marks unsupported social URLs as social", () => {
    expect(detectSourceType("https://www.instagram.com/reel/abc123").sourceType).toBe("social");
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
