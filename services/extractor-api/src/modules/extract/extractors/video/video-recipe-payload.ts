import { z } from "zod";

/*
 * What Gemini answers after watching a recipe video. Every ingredient and step carries where it
 * came from and the words heard or read (`quote`), so build-video-recipe-candidate.ts can check
 * the amounts and names against them and drop what the video does not support.
 */
const evidenceSourceSchema = z.enum(["speech", "on_screen_text", "caption", "visual"]);

export type VideoEvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const videoRecipePayloadSchema = z.object({
  recipeInVideo: z.boolean(),
  notRecipeReason: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  servings: z.string().nullable().default(null),
  prepTimeMinutes: z.number().int().nonnegative().nullable().default(null),
  cookTimeMinutes: z.number().int().nonnegative().nullable().default(null),
  ingredients: z
    .array(
      z.object({
        item: z.string(),
        amount: z.string().nullable(),
        section: z.string().nullable().default(null),
        source: evidenceSourceSchema,
        quote: z.string()
      })
    )
    .default([]),
  steps: z
    .array(
      z.object({
        text: z.string(),
        source: evidenceSourceSchema,
        quote: z.string()
      })
    )
    .default([])
});

export type VideoRecipePayload = z.infer<typeof videoRecipePayloadSchema>;

const evidenceSourceJsonSchema = {
  type: "string",
  enum: ["speech", "on_screen_text", "caption", "visual"]
} as const;

export const videoRecipeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "recipeInVideo",
    "notRecipeReason",
    "title",
    "servings",
    "prepTimeMinutes",
    "cookTimeMinutes",
    "ingredients",
    "steps"
  ],
  properties: {
    recipeInVideo: {
      type: "boolean",
      description:
        "True only when the video shows or tells how to make a specific dish well enough to cook it."
    },
    notRecipeReason: { type: ["string", "null"] },
    title: { type: ["string", "null"], description: "The dish's name as the video gives it." },
    servings: { type: ["string", "null"] },
    prepTimeMinutes: { type: ["integer", "null"], minimum: 0 },
    cookTimeMinutes: { type: ["integer", "null"], minimum: 0 },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "amount", "section", "source", "quote"],
        properties: {
          item: { type: "string", description: "The ingredient, e.g. 'garlic, minced'." },
          amount: {
            type: ["string", "null"],
            description:
              "The amount exactly as said or shown, e.g. '3 cloves' or '1/2 cup'. Null when the video gives none."
          },
          section: { type: ["string", "null"], description: "e.g. 'Sauce', or null." },
          source: evidenceSourceJsonSchema,
          quote: {
            type: "string",
            description:
              "The exact words heard or text shown that name this ingredient and its amount. For 'visual', a short description of what is shown."
          }
        }
      }
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "source", "quote"],
        properties: {
          text: { type: "string", description: "One method step, in the video's order." },
          source: evidenceSourceJsonSchema,
          quote: {
            type: "string",
            description:
              "The words heard or text shown for this step, or for 'visual' a short description of the action shown."
          }
        }
      }
    }
  }
} as const;

export interface VideoRecipeContext {
  platform: "tiktok" | "youtube";
  /** The TikTok caption or the YouTube description, as posted. */
  caption: string | null;
  title: string | null;
  authorName: string | null;
}

const maxContextChars = 4_000;

export const buildVideoRecipePrompt = (context: VideoRecipeContext): string =>
  [
    `Watch this ${context.platform === "tiktok" ? "TikTok" : "YouTube"} video from start to finish, listening to everything said and reading all on-screen text, and write down the recipe it teaches.`,
    "Rules:",
    "- Report only what the video itself says, shows as text, or plainly shows being done, plus what the creator's caption below states. Never add ingredients, amounts, temperatures or times from general cooking knowledge, even when the dish usually has them.",
    "- amount: copy the amount exactly as it is said or shown. When the video gives no amount for an ingredient, amount is null. Never estimate one from what you see.",
    "- source and quote: for each ingredient and step, say where it came from. speech = said aloud (quote the words heard), on_screen_text = written on screen (quote the text), caption = the caption below (quote it), visual = only shown, never named (describe what is shown, and amount must be null).",
    "- List every ingredient once, in the order used. Keep sections such as Sauce or Topping when the video uses them.",
    "- Steps are short instructions in the video's order, written for someone cooking along.",
    "- If the video is not a recipe (a review, a taste test, a vlog, a product video, a mukbang), or it never shows enough to cook the dish, set recipeInVideo to false, say why in notRecipeReason, and leave ingredients and steps empty.",
    ...(context.title ? [`Video title: ${context.title}`] : []),
    ...(context.authorName ? [`Creator: ${context.authorName}`] : []),
    `Caption: ${context.caption?.trim().slice(0, maxContextChars) || "(none)"}`
  ].join("\n");

/** A separate, explicitly requested creation, never used for normal extraction. */
export const buildInspiredVideoRecipePrompt = (context: VideoRecipeContext): string =>
  [
    "Watch the video and identify a specific food shown or discussed. If no food can be identified, set recipeInVideo to false and leave ingredients and steps empty.",
    "Otherwise create a practical recipe inspired by that food, using general cooking knowledge for any missing ingredients, amounts and steps. This is a newly created recipe, not a transcription of the creator's recipe. Do not claim that estimated details were in the video.",
    "Give realistic quantities and clear, complete cooking steps. Use safe cooking temperatures where relevant. Set recipeInVideo to true when a food can be identified; title, ingredients and steps must describe the new recipe. For each ingredient and step set source to visual and quote to 'AI-created'.",
    `Video title: ${context.title?.slice(0, 500) ?? "(none)"}`,
    `Caption: ${context.caption?.slice(0, maxContextChars) ?? "(none)"}`
  ].join("\n");
