import { z } from "zod";

import { buildFallbackInputText } from "./build-fallback-input.js";
import { FallbackProviderError } from "./errors.js";

import type {
  FallbackExtractionInput,
  FallbackRecipeExtractor,
  ExtractionCandidate
} from "../types.js";

const fallbackRecipePayloadSchema = z.object({
  title: z.string().min(1),
  ingredients: z
    .array(
      z.object({
        text: z.string().min(1),
        section: z.string().min(1).nullable()
      })
    )
    .min(1),
  steps: z.array(z.string().min(1)).min(1),
  servings: z.string().nullable(),
  prepTimeMinutes: z.number().int().nonnegative().nullable(),
  cookTimeMinutes: z.number().int().nonnegative().nullable(),
  nutrition: z
    .object({
      calories: z.string().nullable(),
      protein: z.string().nullable(),
      carbohydrates: z.string().nullable(),
      fat: z.string().nullable(),
      fiber: z.string().nullable(),
      sugar: z.string().nullable(),
      sodium: z.string().nullable()
    })
    .nullable(),
  warnings: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([])
});

const fallbackRecipeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "ingredients",
    "steps",
    "servings",
    "prepTimeMinutes",
    "cookTimeMinutes",
    "nutrition",
    "warnings",
    "evidence"
  ],
  properties: {
    title: { type: "string", description: "Recipe title." },
    ingredients: {
      type: "array",
      description:
        "Ingredient lines in source order. Preserve section labels such as Cake, Frosting, Sauce, Filling, Marinade, Dressing, Dough, or Topping on each ingredient. Use null only when the source has no section for that ingredient.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "section"],
        properties: {
          text: { type: "string" },
          section: { type: ["string", "null"] }
        }
      },
      minItems: 1
    },
    steps: {
      type: "array",
      items: { type: "string" },
      minItems: 1
    },
    servings: { type: ["string", "null"] },
    prepTimeMinutes: { type: ["integer", "null"], minimum: 0 },
    cookTimeMinutes: { type: ["integer", "null"], minimum: 0 },
    nutrition: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["calories", "protein", "carbohydrates", "fat", "fiber", "sugar", "sodium"],
      properties: {
        calories: { type: ["string", "null"] },
        protein: { type: ["string", "null"] },
        carbohydrates: { type: ["string", "null"] },
        fat: { type: ["string", "null"] },
        fiber: { type: ["string", "null"] },
        sugar: { type: ["string", "null"] },
        sodium: { type: ["string", "null"] }
      }
    },
    warnings: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } }
  }
} as const;

const toExtractionCandidate = (
  payload: z.infer<typeof fallbackRecipePayloadSchema>,
  input: FallbackExtractionInput
): ExtractionCandidate => ({
  recipe: {
    title: payload.title,
    ingredients: payload.ingredients.map((ingredient) => ({
      section: ingredient.section,
      text: ingredient.text
    })),
    steps: payload.steps.map((text, index) => ({
      index: index + 1,
      text
    })),
    servings: payload.servings,
    prepTimeMinutes: payload.prepTimeMinutes,
    cookTimeMinutes: payload.cookTimeMinutes,
    nutrition: payload.nutrition
  },
  strategy: "llm-fallback",
  evidence: payload.evidence,
  warnings: payload.warnings,
  provenance: ["llm"],
  fieldProvenance: {
    title: "llm",
    ingredients: "llm",
    steps: "llm",
    servings: payload.servings ? "llm" : null,
    prepTimeMinutes: payload.prepTimeMinutes == null ? null : "llm",
    cookTimeMinutes: payload.cookTimeMinutes == null ? null : "llm",
    nutrition: payload.nutrition ? "llm" : null
  },
  signals: {
    requiredFieldsInferred: false,
    titleConfidence: "strong",
    timesFromStructuredMetadata: false,
    recipeLike: true,
    detectionConfidence: input.detection.confidence,
    sectionCohesion: "medium",
    transcriptQuality:
      input.sourceDocument.kind === "youtube"
        ? input.sourceDocument.transcript
          ? "strong"
          : "missing"
        : "weak",
    usedBrowserFallback: input.fetchMode === "browser",
    blockedSourceSignals:
      input.sourceDocument.kind === "html" ? input.sourceDocument.blockedSignals.length : 0
  }
});

const getBase64Payload = (dataUrl: string): string => dataUrl.replace(/^data:[^;]+;base64,/iu, "");

const buildGeminiParts = (input: FallbackExtractionInput) => [
  {
    text: buildFallbackInputText(input)
  },
  ...(input.sourceDocument.kind === "image"
    ? input.sourceDocument.images.map((image) => ({
        inlineData: {
          data: getBase64Payload(image.dataUrl),
          mimeType: image.mimeType
        }
      }))
    : [])
];

class AvailableGeminiFallbackExtractor implements FallbackRecipeExtractor {
  public readonly available = true;
  public readonly providerName = "gemini" as const;
  private readonly maxAttempts = 2;

  public constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImplementation: typeof fetch,
    private readonly timeoutMs: number
  ) {}

  public async extract(input: FallbackExtractionInput): Promise<ExtractionCandidate | null> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      const generationConfig = {
        ...(this.model.startsWith("gemini-3") ? {} : { temperature: 0 }),
        responseMimeType: "application/json",
        responseJsonSchema: fallbackRecipeJsonSchema
      };

      try {
        const response = await this.fetchImplementation(
          `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": this.apiKey
            },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [
                {
                  parts: buildGeminiParts(input)
                }
              ],
              generationConfig
            })
          }
        );

        if (!response.ok) {
          if (response.status === 429) {
            throw new FallbackProviderError("Gemini fallback quota exceeded.", "quota_exceeded");
          }

          throw new FallbackProviderError("Gemini fallback request failed.", "fallback_failed");
        }

        const body = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
              }>;
            };
          }>;
        };
        const text = body.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
          continue;
        }

        const parsed = fallbackRecipePayloadSchema.safeParse(JSON.parse(text) as unknown);

        if (!parsed.success) {
          continue;
        }

        return toExtractionCandidate(parsed.data, input);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return null;
  }
}

class UnavailableGeminiFallbackExtractor implements FallbackRecipeExtractor {
  public readonly available = false;
  public readonly providerName = "none" as const;

  public extract(): Promise<null> {
    return Promise.resolve(null);
  }
}

export const createGeminiFallbackExtractor = (options: {
  apiKey: string | undefined;
  model: string | undefined;
  fetchImplementation: typeof fetch;
  timeoutMs: number;
}): FallbackRecipeExtractor =>
  options.apiKey && options.model
    ? new AvailableGeminiFallbackExtractor(
        options.apiKey,
        options.model,
        options.fetchImplementation,
        options.timeoutMs
      )
    : new UnavailableGeminiFallbackExtractor();
