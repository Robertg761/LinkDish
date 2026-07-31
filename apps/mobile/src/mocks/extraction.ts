import type { ExtractRecipeRequest, ExtractRecipeResponse } from "@linkdish/api-contracts";

const buildSuccessResponse = (
  url: string,
  strategy: "article-pattern" | "llm-fallback" = "article-pattern",
  sourceType: "article" | "image" = "article"
): ExtractRecipeResponse => ({
  status: "success",
  recipe: {
    title:
      sourceType === "image"
        ? "Scanned Weeknight Coconut Lentil Curry"
        : "Weeknight Coconut Lentil Curry",
    sourceUrl: url,
    sourceType,
    ingredients: [
      { text: "1 cup red lentils" },
      { text: "1 tbsp curry paste" },
      { text: "1 can coconut milk" },
      { text: "2 cups spinach" }
    ],
    steps: [
      { index: 1, text: "Simmer lentils in coconut milk with curry paste." },
      { index: 2, text: "Fold in spinach and cook until wilted." },
      { index: 3, text: "Season to taste and serve with rice." }
    ],
    servings: "4 servings",
    prepTimeMinutes: 10,
    cookTimeMinutes: 25,
    nutrition: {
      calories: "390 kcal",
      protein: "18 g",
      carbohydrates: "42 g",
      fat: "16 g",
      fiber: "11 g",
      sugar: "7 g",
      sodium: "520 mg"
    },
    confidence: {
      score: strategy === "llm-fallback" ? 0.81 : 0.68,
      summary:
        strategy === "llm-fallback"
          ? sourceType === "image"
            ? "Mock mode read recipe details from a scanned image."
            : "LinkDish cleaned up the recipe using extra import help."
          : "Mock mode is active in the mobile app.",
      missingFields: [],
      notes: ["Switch EXPO_PUBLIC_USE_MOCK_API to false to hit the backend service."],
      fieldProvenance: {
        title: "visible-text",
        ingredients: strategy === "llm-fallback" ? "llm" : "visible-text",
        steps: strategy === "llm-fallback" ? "llm" : "visible-text",
        servings: "visible-text",
        prepTimeMinutes: "visible-text",
        cookTimeMinutes: "visible-text",
        nutrition: "visible-text"
      }
    }
  },
  extraction: {
    sourceType,
    strategy,
    confidenceScore: strategy === "llm-fallback" ? 0.81 : 0.68,
    missingFields: [],
    fetchMode: strategy === "llm-fallback" ? "browser" : "http",
    provenance:
      strategy === "llm-fallback" ? ["llm", "visible-text"] : ["readability", "visible-text"],
    warnings:
      strategy === "llm-fallback"
        ? ["Fallback extraction inferred some formatting from source context."]
        : ["Mock mode is active in the mobile app."]
  }
});

const isVideoUrl = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be" ||
      hostname.endsWith(".youtu.be")
    );
  } catch {
    return false;
  }
};

export const buildMockExtractionResponse = (
  request: ExtractRecipeRequest
): ExtractRecipeResponse => {
  if ("images" in request) {
    return buildSuccessResponse(request.sourceUrl, "llm-fallback", "image");
  }

  const { attempt, url } = request;

  if (url.includes("unsupported") || isVideoUrl(url)) {
    return {
      status: "failure",
      reason: "unsupported_source",
      userMessage:
        "Video links and shorts are not supported yet. Paste a written recipe page instead.",
      recovery: {
        retryable: false,
        allowFallback: false,
        suggestedAction: "try_another_url"
      }
    };
  }

  if (url.includes("blocked")) {
    return {
      status: "failure",
      reason: "source_blocked",
      userMessage: "That source blocked recipe extraction right now.",
      recovery: {
        retryable: false,
        allowFallback: false,
        suggestedAction: "try_another_url"
      }
    };
  }

  if (url.includes("timeout")) {
    return {
      status: "failure",
      reason: "timeout",
      userMessage: "That source took too long to respond.",
      recovery: {
        retryable: true,
        allowFallback: false,
        suggestedAction: "retry_primary"
      }
    };
  }

  if (attempt === "fallback") {
    return buildSuccessResponse(url, "llm-fallback");
  }

  if (url.includes("retry")) {
    return {
      status: "needs_retry",
      reason: "low_confidence",
      sourceType: "article",
      suggestedAttempt: "fallback",
      userMessage: "We found something, but it is not reliable enough yet.",
      diagnostics: {
        confidenceScore: 0.58,
        missingFields: ["servings", "cookTimeMinutes"]
      },
      recovery: {
        retryable: true,
        allowFallback: true,
        suggestedAction: "retry_fallback"
      }
    };
  }

  return buildSuccessResponse(url);
};
