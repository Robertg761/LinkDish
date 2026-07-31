import { describe, expect, it } from "vitest";

import {
  accountUserSchema,
  createWebBillingCheckoutRequestSchema,
  deleteShoppingItemsRequestSchema,
  householdShoppingListResponseSchema,
  extractRecipeFailureSchema,
  extractRecipeNeedsRetrySchema,
  extractRecipeRequestSchema,
  extractRecipeResponseSchema,
  extractRecipeSuccessSchema,
  MAX_HOUSEHOLD_SHOPPING_ITEMS,
  MAX_SHARED_RECIPE_PAYLOAD_CHARS,
  sharedRecipeListResponseSchema,
  updateAccountProfileRequestSchema,
  updateSharedRecipeRequestSchema,
  upsertShoppingItemsRequestSchema,
  upsertSharedRecipeRequestSchema
} from "./index";

describe("extract recipe contracts", () => {
  it("rejects invalid urls", () => {
    const parsed = extractRecipeRequestSchema.safeParse({
      url: "not-a-url"
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts image extraction requests", () => {
    const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";
    const parsed = extractRecipeRequestSchema.parse({
      images: [
        {
          dataUrl: "data:image/jpeg;base64,abc123",
          mimeType: "image/jpeg"
        }
      ],
      sourceUrl: "https://linkdish.app/image-imports/test",
      correlationId
    });

    expect(parsed).toMatchObject({
      attempt: "fallback",
      correlationId,
      sourceUrl: "https://linkdish.app/image-imports/test"
    });
  });

  it("accepts a valid mocked recipe response", () => {
    const parsed = extractRecipeSuccessSchema.parse({
      status: "success",
      recipe: {
        title: "Sheet Pan Gnocchi",
        sourceUrl: "https://example.com/gnocchi",
        sourceType: "article",
        image: {
          source: "og",
          url: "https://cdn.example.com/gnocchi.jpg"
        },
        ingredients: [{ text: "1 package gnocchi" }],
        steps: [{ index: 1, text: "Roast everything together." }],
        servings: "4 servings",
        prepTimeMinutes: 5,
        cookTimeMinutes: 20,
        nutrition: null,
        confidence: {
          score: 0.78,
          summary: "Article fallback parsing was used.",
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
        confidenceScore: 0.78,
        missingFields: [],
        warnings: [],
        fetchMode: "http",
        provenance: ["readability", "visible-text"]
      }
    });

    expect(parsed.recipe.sourceType).toBe("article");
    expect(parsed.recipe.image?.source).toBe("og");
  });

  it("accepts a retryable response", () => {
    const parsed = extractRecipeNeedsRetrySchema.parse({
      status: "needs_retry",
      reason: "low_confidence",
      sourceType: "article",
      suggestedAttempt: "fallback",
      userMessage: "Try a stronger extraction pass.",
      diagnostics: {
        confidenceScore: 0.62,
        missingFields: ["servings"]
      },
      recovery: {
        retryable: true,
        allowFallback: true,
        suggestedAction: "retry_fallback"
      }
    });

    expect(parsed.suggestedAttempt).toBe("fallback");
  });

  it("accepts a failure response", () => {
    const parsed = extractRecipeFailureSchema.parse({
      status: "failure",
      reason: "plan_limit",
      userMessage: "That account has used this month's recipe imports.",
      recovery: {
        retryable: true,
        allowFallback: false,
        suggestedAction: "try_again_later"
      }
    });

    expect(parsed.reason).toBe("plan_limit");
  });

  it("accepts additive quota metadata on failure responses", () => {
    const parsed = extractRecipeFailureSchema.parse({
      status: "failure",
      reason: "plan_limit",
      userMessage: "That account has used this month's recipe imports.",
      quota: {
        limit: 5,
        remaining: 0,
        monthlyLimit: 5,
        remainingThisMonth: 0,
        resetsAt: "2026-08-01T00:00:00.000Z",
        meteringMode: "free_monthly_grandfathered"
      }
    });

    expect(parsed.quota?.monthlyLimit).toBe(5);
    expect(parsed.quota?.meteringMode).toBe("free_monthly_grandfathered");
  });

  it("accepts the union response schema", () => {
    const parsed = extractRecipeResponseSchema.parse({
      status: "failure",
      reason: "parse_failed",
      userMessage: "We could not identify a recipe."
    });

    expect(parsed.status).toBe("failure");
  });
});

describe("account profile contracts", () => {
  it("accepts optional profile fields on account users", () => {
    const parsed = accountUserSchema.parse({
      id: "user_1",
      email: "cook@example.com",
      billingPlan: "family",
      displayName: "Family Cook",
      avatarEmoji: "🍳"
    });

    expect(parsed.billingPlan).toBe("family");
    expect(parsed.displayName).toBe("Family Cook");
    expect(parsed.avatarEmoji).toBe("🍳");
  });

  it("rejects unknown account billing plans", () => {
    const parsed = accountUserSchema.safeParse({
      id: "user_1",
      email: "cook@example.com",
      billingPlan: "enterprise"
    });

    expect(parsed.success).toBe(false);
  });

  it("normalizes empty profile updates to null", () => {
    const parsed = updateAccountProfileRequestSchema.parse({
      displayName: "  ",
      avatarEmoji: ""
    });

    expect(parsed).toEqual({
      avatarEmoji: null,
      displayName: null
    });
  });

  it("accepts single complex emoji avatars", () => {
    for (const avatarEmoji of ["🌶️", "❤️", "👨‍👩‍👧‍👦", "🇨🇦", "1️⃣"]) {
      expect(
        updateAccountProfileRequestSchema.safeParse({
          avatarEmoji
        }).success
      ).toBe(true);
    }
  });

  it("rejects non-emoji profile avatars", () => {
    const parsed = updateAccountProfileRequestSchema.safeParse({
      avatarEmoji: "LD"
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects multiple profile avatar emoji", () => {
    const parsed = updateAccountProfileRequestSchema.safeParse({
      avatarEmoji: "🙂🙂"
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects display names with control or invisible characters", () => {
    for (const displayName of ["Alice\nBob", "Alice\u200BBob", "Alice\u202EBob"]) {
      expect(
        updateAccountProfileRequestSchema.safeParse({
          displayName
        }).success
      ).toBe(false);
    }
  });
});

describe("web billing contracts", () => {
  it("accepts paid checkout requests", () => {
    const parsed = createWebBillingCheckoutRequestSchema.parse({
      period: "yearly",
      plan: "family"
    });

    expect(parsed).toEqual({
      period: "yearly",
      plan: "family"
    });
  });

  it("rejects free checkout requests", () => {
    const parsed = createWebBillingCheckoutRequestSchema.safeParse({
      period: "monthly",
      plan: "free"
    });

    expect(parsed.success).toBe(false);
  });
});

describe("shared recipe contracts", () => {
  const recipe = {
    title: "Sheet Pan Gnocchi",
    sourceUrl: "https://example.com/gnocchi",
    sourceType: "article",
    ingredients: [{ text: "1 package gnocchi" }],
    steps: [{ index: 1, text: "Roast everything together." }],
    servings: "4 servings",
    prepTimeMinutes: 5,
    cookTimeMinutes: 20,
    nutrition: null,
    confidence: {
      score: 0.78,
      summary: "Article fallback parsing was used.",
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
  };

  it("accepts a shared recipe upsert request", () => {
    const parsed = upsertSharedRecipeRequestSchema.parse({
      sourceSavedRecipeId: "saved-1",
      recipe,
      notes: "Use the large pan.",
      fetchMode: "http",
      provenance: ["visible-text"],
      strategy: "article-pattern"
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.recipe.image).toBeNull();
  });

  it("accepts shared recipe image metadata", () => {
    const parsed = upsertSharedRecipeRequestSchema.parse({
      recipe: {
        ...recipe,
        image: {
          height: 720,
          source: "twitter",
          url: "https://cdn.example.com/shared-recipe.jpg",
          width: 960
        }
      },
      fetchMode: "http",
      provenance: ["visible-text"],
      strategy: "article-pattern"
    });

    expect(parsed.recipe.image).toEqual({
      height: 720,
      source: "twitter",
      url: "https://cdn.example.com/shared-recipe.jpg",
      width: 960
    });
  });

  it("accepts clearing shared recipe notes", () => {
    const parsed = updateSharedRecipeRequestSchema.parse({
      notes: null
    });

    expect(parsed.notes).toBeNull();
  });

  it("rejects oversized shared recipe payloads", () => {
    const parsed = upsertSharedRecipeRequestSchema.safeParse({
      recipe: {
        ...recipe,
        ingredients: [
          {
            text: "x".repeat(MAX_SHARED_RECIPE_PAYLOAD_CHARS)
          }
        ]
      },
      fetchMode: "http",
      provenance: ["visible-text"],
      strategy: "article-pattern"
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a shared family recipe list", () => {
    const parsed = sharedRecipeListResponseSchema.parse({
      recipes: [
        {
          id: "shared_recipe_1",
          householdId: "household_1",
          ownerUserId: "user_1",
          ownerEmail: "owner@example.com",
          ownerDisplayName: "Owner Cook",
          ownerAvatarEmoji: "🥘",
          sourceSavedRecipeId: "saved-1",
          recipe,
          notes: "Use the large pan.",
          fetchMode: "http",
          provenance: ["visible-text"],
          strategy: "article-pattern",
          warnings: [],
          createdAt: "2026-05-12T00:00:00.000Z",
          updatedAt: "2026-05-12T00:00:00.000Z"
        }
      ]
    });

    expect(parsed.recipes[0]?.ownerEmail).toBe("owner@example.com");
    expect(parsed.recipes[0]?.ownerDisplayName).toBe("Owner Cook");
  });
});

describe("household shopping contracts", () => {
  const item = {
    id: "shopping_item_1",
    text: "olive oil",
    qty: 1,
    unit: "bottle",
    recipeId: "recipe_1",
    recipeTitle: "Lemon Pasta",
    section: "Pantry",
    addedBy: "user_1",
    checked: false,
    checkedBy: null,
    updatedAt: "2026-07-04T12:00:00.000Z"
  };

  it("accepts shopping list response and upsert batch payloads", () => {
    expect(
      householdShoppingListResponseSchema.parse({
        items: [item]
      })
    ).toEqual({
      items: [item]
    });

    expect(
      upsertShoppingItemsRequestSchema.parse({
        items: [item]
      })
    ).toEqual({
      items: [item]
    });
  });

  it("accepts delete batches with item-level timestamps", () => {
    const parsed = deleteShoppingItemsRequestSchema.parse({
      items: [
        {
          id: item.id,
          updatedAt: "2026-07-04T12:01:00.000Z"
        }
      ]
    });

    expect(parsed.items[0]?.id).toBe(item.id);
  });

  it("rejects over-limit shopping batches", () => {
    const parsed = upsertShoppingItemsRequestSchema.safeParse({
      items: Array.from({ length: MAX_HOUSEHOLD_SHOPPING_ITEMS + 1 }, (_, index) => ({
        ...item,
        id: `shopping_item_${index}`
      }))
    });

    expect(parsed.success).toBe(false);
  });
});
