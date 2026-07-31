import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractYouTubeRecipe } from "./extract-youtube-recipe";

const transcript = readFileSync(
  new URL("../../__fixtures__/youtube-transcript.txt", import.meta.url),
  "utf8"
);

describe("extractYouTubeRecipe", () => {
  it("extracts a recipe from transcript text", () => {
    const candidate = extractYouTubeRecipe({
      kind: "youtube",
      url: "https://www.youtube.com/watch?v=video123",
      videoId: "video123",
      title: "Skillet Chicken",
      description: "A quick skillet dinner.",
      transcript,
      chapters: [],
      pageHtml: null
    });

    expect(candidate?.strategy).toBe("youtube-transcript");
    expect(candidate?.recipe.ingredients).toHaveLength(3);
    expect(candidate?.recipe.steps).toHaveLength(3);
    expect(candidate?.recipe.image).toEqual({
      source: "youtube-thumb",
      url: "https://i.ytimg.com/vi/video123/hqdefault.jpg"
    });
  });

  it("returns null when transcript is unavailable", () => {
    const candidate = extractYouTubeRecipe({
      kind: "youtube",
      url: "https://www.youtube.com/watch?v=video123",
      videoId: "video123",
      title: "Skillet Chicken",
      description: "A quick skillet dinner.",
      transcript: null,
      chapters: [],
      pageHtml: null
    });

    expect(candidate).toBeNull();
  });
});
