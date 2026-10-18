import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VIDEO_METHOD_STEP } from "../text/extract-text-recipe";

import { extractYouTubeRecipe, findYouTubeRecipeLinks } from "./extract-youtube-recipe";

import type { YouTubeSourceDocument } from "../../types";

const recipeText = readFileSync(
  new URL("../../__fixtures__/youtube-transcript.txt", import.meta.url),
  "utf8"
);

const video = (overrides: Partial<YouTubeSourceDocument>): YouTubeSourceDocument => ({
  kind: "youtube",
  url: "https://www.youtube.com/watch?v=video123",
  videoId: "video123",
  title: "Skillet Chicken",
  description: "A quick skillet dinner.",
  transcript: null,
  chapters: [],
  pageHtml: null,
  ...overrides
});

describe("extractYouTubeRecipe", () => {
  it("reads the recipe the description lays out, titled after the video", () => {
    const extraction = extractYouTubeRecipe(video({ description: recipeText }));

    expect(extraction?.methodInVideo).toBe(false);
    expect(extraction?.candidate.strategy).toBe("youtube-transcript");
    expect(extraction?.candidate.provenance).toEqual(["visible-text"]);
    expect(extraction?.candidate.recipe).toMatchObject({
      title: "Skillet Chicken",
      ingredients: [
        { text: "1 lb chicken thighs", section: null },
        { text: "2 tbsp soy sauce", section: null },
        { text: "1 tbsp honey", section: null }
      ],
      steps: [
        { index: 1, text: "Season the chicken thighs with salt." },
        { index: 2, text: "Sear the chicken in a hot skillet." },
        { index: 3, text: "Add soy sauce and honey, then simmer until glossy." }
      ],
      servings: "4 people",
      prepTimeMinutes: 10,
      cookTimeMinutes: 18,
      videoUrl: "https://www.youtube.com/watch?v=video123",
      image: { source: "youtube-thumb", url: "https://i.ytimg.com/vi/video123/hqdefault.jpg" }
    });
  });

  it("uses a transcript only when it is laid out as a recipe and the description is not", () => {
    const extraction = extractYouTubeRecipe(video({ transcript: recipeText }));

    expect(extraction?.candidate.provenance).toEqual(["transcript"]);
    expect(extraction?.candidate.recipe.ingredients).toHaveLength(3);
  });

  it("prefers a recipe transcript over a description with only method notes", () => {
    const extraction = extractYouTubeRecipe(
      video({
        description: [
          "200g Cream cheese",
          "40g Sugar",
          "*Freeze for 2 hours",
          "100g Chocolate",
          "18g Corn oil"
        ].join("\n"),
        transcript: recipeText
      })
    );

    expect(extraction?.candidate.provenance).toEqual(["transcript"]);
    expect(extraction?.methodInVideo).toBe(false);
  });

  it("returns null for a description and a spoken transcript without a recipe layout", () => {
    expect(
      extractYouTubeRecipe(
        video({
          description: "Easy chocolate cake! Subscribe for more 🍫 #cake #baking",
          transcript:
            "so today we're going to make a cake you need some eggs and some sugar and then you mix it"
        })
      )
    ).toBeNull();
  });

  it("keeps an ingredients-only description and points to the video for the method", () => {
    const extraction = extractYouTubeRecipe(
      video({
        description: "INGREDIENTS:\n500g beef chuck\n2 carrots\n1 onion\n2 cups beef stock"
      })
    );

    expect(extraction?.methodInVideo).toBe(true);
    expect(extraction?.candidate.recipe.steps).toEqual([{ index: 1, text: VIDEO_METHOD_STEP }]);
    expect(extraction?.candidate.signals.requiredFieldsInferred).toBe(true);
  });

  it("keeps a description's method notes after the step that points to the video", () => {
    const extraction = extractYouTubeRecipe(
      video({
        description: [
          "Tasty Recipe:",
          "6 Puff pastry",
          "9 Sausages",
          "Mozzarella cheese",
          "1 Egg",
          "",
          "Bake in preheated oven at 180℃ for 20 minutes",
          "",
          "Thanks for watching♥",
          "Please like👍 and share this video 🌹"
        ].join("\n")
      })
    );

    expect(extraction?.methodInVideo).toBe(true);
    expect(extraction?.candidate.recipe.steps).toEqual([
      { index: 1, text: VIDEO_METHOD_STEP },
      { index: 2, text: "Bake in preheated oven at 180℃ for 20 minutes" }
    ]);
  });
});

describe("findYouTubeRecipeLinks", () => {
  it("ranks a link labelled as the recipe first and skips socials, shops and home pages", () => {
    const links = findYouTubeRecipeLinks(
      video({
        description: [
          "My favourite stew!",
          "Instagram: https://instagram.com/cook",
          "Shop my knives: https://amzn.to/abc",
          "Website: https://cookblog.example",
          "Another recipe you'll love: https://cookblog.example/recipes/soup/",
          "Full recipe:",
          "https://cookblog.example/beef-stew/",
          "Music: https://example.com/track"
        ].join("\n")
      })
    );

    expect(links).toEqual([
      "https://cookblog.example/beef-stew/",
      "https://cookblog.example/recipes/soup/"
    ]);
  });

  it("keeps a query-routed recipe permalink", () => {
    expect(
      findYouTubeRecipeLinks(video({ description: "Full recipe: https://blog.example/?p=123" }))
    ).toEqual(["https://blog.example/?p=123"]);
    expect(
      findYouTubeRecipeLinks(
        video({ description: "Full recipe: https://cook.example/#/recipes/123" })
      )
    ).toEqual(["https://cook.example/#/recipes/123"]);
  });

  it("finds nothing in a description without recipe links", () => {
    expect(
      findYouTubeRecipeLinks(video({ description: "Follow me https://tiktok.com/@cook" }))
    ).toEqual([]);
  });
});
