import OpenAI from "openai";
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

type FallbackRecipePayload = z.infer<typeof fallbackRecipePayloadSchema>;

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
    title: { type: "string" },
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
    servings: {
      type: ["string", "null"]
    },
    prepTimeMinutes: {
      type: ["integer", "null"],
      minimum: 0
    },
    cookTimeMinutes: {
      type: ["integer", "null"],
      minimum: 0
    },
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
    warnings: {
      type: "array",
      items: { type: "string" }
    },
    evidence: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

const toExtractionCandidate = (
  payload: FallbackRecipePayload,
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

const buildOpenAiInput = (input: FallbackExtractionInput) => {
  const prompt = buildFallbackInputText(input);

  if (input.sourceDocument.kind !== "image") {
    return prompt;
  }

  return [
    {
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: prompt
        },
        ...input.sourceDocument.images.map((image) => ({
          type: "input_image" as const,
          image_url: image.dataUrl,
          detail: "high" as const
        }))
      ]
    }
  ];
};

class AvailableOpenAiFallbackExtractor implements FallbackRecipeExtractor {
  public readonly available = true;
  public readonly providerName = "openai" as const;

  public constructor(
    private readonly client: OpenAI,
    private readonly model: string
  ) {}

  public async extract(input: FallbackExtractionInput): Promise<ExtractionCandidate | null> {
    try {
      const response = await this.client.responses.create({
        model: this.model,
        instructions:
          "You extract structured cooking recipes from URLs, webpages, articles, YouTube transcripts, and recipe images. Preserve ingredient sections and method context exactly when visible. Return only the schema requested.",
        input: buildOpenAiInput(input),
        text: {
          format: {
            type: "json_schema",
            name: "linkdish_recipe_extraction",
            strict: true,
            schema: fallbackRecipeJsonSchema
          }
        }
      });

      if (!response.output_text) {
        return null;
      }

      const parsed = fallbackRecipePayloadSchema.safeParse(
        JSON.parse(response.output_text) as unknown
      );
      return parsed.success ? toExtractionCandidate(parsed.data, input) : null;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error as { status?: number }).status === 429
      ) {
        throw new FallbackProviderError("OpenAI fallback quota exceeded.", "quota_exceeded");
      }

      throw new FallbackProviderError("OpenAI fallback request failed.", "fallback_failed");
    }
  }
}

class UnavailableOpenAiFallbackExtractor implements FallbackRecipeExtractor {
  public readonly available = false;
  public readonly providerName = "none" as const;

  public extract(): Promise<null> {
    return Promise.resolve(null);
  }
}

export const createOpenAiFallbackExtractor = (
  apiKey: string | undefined,
  model: string | undefined
): FallbackRecipeExtractor => {
  if (!apiKey || !model) {
    return new UnavailableOpenAiFallbackExtractor();
  }

  return new AvailableOpenAiFallbackExtractor(new OpenAI({ apiKey }), model);
};
