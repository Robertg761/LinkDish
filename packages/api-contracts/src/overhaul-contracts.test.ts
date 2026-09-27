import { describe, expect, it } from "vitest";

import {
  analyticsEventBatchRequestSchema,
  analyticsEventBatchResponseSchema,
  analyticsEventNameSchema,
  billingUsageResponseSchema,
  extractRecipeAnyRequestSchema,
  extractRecipeRequestSchema,
  extractRecipeResponseSchema,
  extractRecipeSuccessSchema,
  extractRecipeTextRequestSchema,
  MAX_EXTRACT_TEXT_CHARS,
  parseAnalyticsEventBatch
} from "./index";

const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";
const recipeText = [
  "Weeknight lentil soup",
  "Ingredients: 1 cup red lentils, 1 onion, 4 cups stock",
  "Simmer everything for 25 minutes."
].join("\n");

const successEnvelope = {
  status: "success",
  recipe: {
    title: "Soup",
    sourceUrl: "https://example.com/soup",
    sourceType: "article",
    ingredients: [{ text: "1 onion" }],
    steps: [{ index: 1, text: "Cook." }],
    servings: "4 servings",
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    nutrition: null,
    confidence: {
      score: 0.81,
      summary: "Confident extraction.",
      missingFields: [],
      notes: [],
      fieldProvenance: {
        title: "visible-text",
        ingredients: "visible-text",
        steps: "visible-text",
        servings: "visible-text",
        prepTimeMinutes: "visible-text",
        cookTimeMinutes: "visible-text",
        nutrition: null
      }
    }
  },
  extraction: {
    sourceType: "article",
    strategy: "article-pattern",
    confidenceScore: 0.81,
    missingFields: [],
    warnings: [],
    fetchMode: "http",
    provenance: ["visible-text"]
  }
} as const;

const quota = {
  limit: 3,
  remaining: 2,
  monthlyLimit: null,
  remainingThisMonth: null,
  resetsAt: null,
  meteringMode: "free_lifetime"
} as const;

describe("pasted text extraction requests", () => {
  it("accepts text with an optional source url and defaults to a fallback attempt", () => {
    const parsed = extractRecipeTextRequestSchema.parse({
      text: `  ${recipeText}  `,
      sourceUrl: "https://www.tiktok.com/@cook/video/123",
      correlationId
    });

    expect(parsed).toEqual({
      text: recipeText,
      sourceUrl: "https://www.tiktok.com/@cook/video/123",
      attempt: "fallback",
      correlationId
    });
  });

  it("bounds the text length after trimming", () => {
    expect(
      extractRecipeTextRequestSchema.safeParse({ text: `${" ".repeat(40)}too short` }).success
    ).toBe(false);
    expect(
      extractRecipeTextRequestSchema.safeParse({ text: "a".repeat(MAX_EXTRACT_TEXT_CHARS + 1) })
        .success
    ).toBe(false);
    expect(
      extractRecipeTextRequestSchema.safeParse({ text: "a".repeat(MAX_EXTRACT_TEXT_CHARS) }).success
    ).toBe(true);
  });

  it("rejects unsafe source urls on text requests", () => {
    expect(
      extractRecipeTextRequestSchema.safeParse({
        text: recipeText,
        sourceUrl: "javascript:alert(1)"
      }).success
    ).toBe(false);
  });

  it("is accepted by the server-side union but not by the legacy request schema", () => {
    expect(extractRecipeAnyRequestSchema.parse({ text: recipeText })).toMatchObject({
      text: recipeText,
      attempt: "fallback"
    });
    expect(extractRecipeRequestSchema.safeParse({ text: recipeText }).success).toBe(false);
  });

  it("still routes url and image payloads through the server-side union unchanged", () => {
    expect(extractRecipeAnyRequestSchema.parse({ url: "https://example.com/soup" })).toEqual({
      url: "https://example.com/soup",
      attempt: "primary"
    });
    expect(
      extractRecipeAnyRequestSchema.parse({
        images: [{ dataUrl: "data:image/jpeg;base64,abc123", mimeType: "image/jpeg" }],
        sourceUrl: "https://linkdish.app/image-imports/test"
      })
    ).toMatchObject({ attempt: "fallback" });
  });
});

describe("quota on success responses", () => {
  it("accepts success responses without quota (older servers)", () => {
    expect(extractRecipeSuccessSchema.safeParse(successEnvelope).success).toBe(true);
  });

  it("accepts and keeps an optional quota status", () => {
    const parsed = extractRecipeResponseSchema.parse({ ...successEnvelope, quota });

    expect(parsed.status === "success" ? parsed.quota : null).toEqual(quota);
  });

  it("rejects a malformed quota status", () => {
    expect(
      extractRecipeSuccessSchema.safeParse({ ...successEnvelope, quota: { ...quota, limit: -1 } })
        .success
    ).toBe(false);
  });

  it("describes GET /billing/usage", () => {
    expect(billingUsageResponseSchema.parse({ billingEnabled: true, plan: "free", quota })).toEqual(
      { billingEnabled: true, plan: "free", quota }
    );
    expect(
      billingUsageResponseSchema.parse({ billingEnabled: false, plan: null, quota: null })
    ).toEqual({ billingEnabled: false, plan: null, quota: null });
  });
});

describe("tolerant analytics batches", () => {
  const event = (eventName: string) => ({
    eventName,
    platform: "web_app",
    occurredAt: "2026-09-27T12:00:00.000Z",
    properties: {}
  });

  it("knows the overhaul event names", () => {
    for (const name of [
      "recipe_favorited",
      "recipe_rated",
      "recipe_tagged",
      "collection_created",
      "meal_plan_entry_added",
      "meal_plan_shopping_generated",
      "library_exported",
      "library_imported",
      "shopping_list_shared",
      "cook_timer_started",
      "command_palette_used",
      "theme_changed",
      "units_changed",
      "import_queued_offline",
      "web_vitals"
    ]) {
      expect(analyticsEventNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("keeps valid events and counts the dropped ones", () => {
    const parsed = parseAnalyticsEventBatch({
      events: [
        event("recipe_favorited"),
        event("from_a_future_client"),
        { ...event("web_route_viewed"), properties: { ok: true } },
        "not an event"
      ]
    });

    expect(parsed?.events.map((entry) => entry.eventName)).toEqual([
      "recipe_favorited",
      "web_route_viewed"
    ]);
    expect(parsed?.dropped).toBe(2);
    expect(parsed?.droppedPaths).toEqual(["events.1.eventName", "events.3"]);
  });

  it("returns null only for an invalid envelope", () => {
    expect(parseAnalyticsEventBatch(null)).toBeNull();
    expect(parseAnalyticsEventBatch({ events: [] })).toBeNull();
    expect(
      parseAnalyticsEventBatch({ events: Array.from({ length: 26 }, () => event("web_vitals")) })
    ).toBeNull();
  });

  it("keeps the strict batch schema for clients validating before sending", () => {
    expect(
      analyticsEventBatchRequestSchema.safeParse({ events: [event("from_a_future_client")] })
        .success
    ).toBe(false);
  });

  it("keeps dropped counts optional in responses", () => {
    expect(analyticsEventBatchResponseSchema.parse({ accepted: 3 })).toEqual({ accepted: 3 });
    expect(analyticsEventBatchResponseSchema.parse({ accepted: 3, dropped: 1 })).toEqual({
      accepted: 3,
      dropped: 1
    });
  });
});
