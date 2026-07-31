import { describe, expect, it } from "vitest";

import { buildMockExtractionResponse } from "./extraction";

describe("buildMockExtractionResponse", () => {
  it("simulates retryable and fallback flows", () => {
    const retryResponse = buildMockExtractionResponse({
      url: "https://example.com/retry",
      attempt: "primary"
    });
    const fallbackResponse = buildMockExtractionResponse({
      url: "https://example.com/retry",
      attempt: "fallback"
    });

    expect(retryResponse.status).toBe("needs_retry");
    expect(fallbackResponse.status).toBe("success");
  });

  it("simulates image extraction", () => {
    const response = buildMockExtractionResponse({
      images: [
        {
          dataUrl: "data:image/jpeg;base64,abc123",
          mimeType: "image/jpeg"
        }
      ],
      sourceUrl: "https://linkdish.app/image-imports/test",
      attempt: "fallback"
    });

    expect(response.status).toBe("success");
    expect(response.status === "success" ? response.recipe.sourceType : null).toBe("image");
  });
});
