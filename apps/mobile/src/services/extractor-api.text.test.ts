import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  extractRecipe: vi.fn(),
  extractRecipeFromText: vi.fn()
}));

vi.mock("../analytics/client", () => ({
  getMobileAnalyticsHeaders: () => Promise.resolve({ "x-linkdish-client-id": "test-client-id" }),
  trackMobileEvent: vi.fn()
}));

vi.mock("../config/env", () => ({
  mobileEnv: { apiBaseUrl: "https://api.example.com", useMockApi: false }
}));

vi.mock("@linkdish/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClientModule>()),
  createExtractorApiClient: () => clientMocks
}));

import { extractRecipe } from "./extractor-api";

import type * as ApiClientModule from "@linkdish/api-client";

describe("extractRecipe with pasted text", () => {
  beforeEach(() => {
    clientMocks.extractRecipe.mockReset();
    clientMocks.extractRecipeFromText.mockReset();
    clientMocks.extractRecipeFromText.mockResolvedValue({ status: "failure" });
  });

  it("sends the text (and a caption's link) but never the route key", async () => {
    await extractRecipe({
      attempt: "primary",
      correlationId: "import-1",
      routeUrl: "https://linkdish.app/text-imports/android-text-1",
      sourceUrl: "https://www.tiktok.com/@cook/video/1",
      text: "Pancakes: 2 eggs, 1 cup flour, fry."
    });

    expect(clientMocks.extractRecipe).not.toHaveBeenCalled();
    expect(clientMocks.extractRecipeFromText).toHaveBeenCalledWith({
      attempt: "primary",
      correlationId: "import-1",
      sourceUrl: "https://www.tiktok.com/@cook/video/1",
      text: "Pancakes: 2 eggs, 1 cup flour, fry."
    });
  });

  it("leaves the source to the API when the text has no link", async () => {
    await extractRecipe({
      attempt: "primary",
      routeUrl: "https://linkdish.app/text-imports/android-text-2",
      text: "Pancakes: 2 eggs, 1 cup flour, fry."
    });

    expect(clientMocks.extractRecipeFromText).toHaveBeenCalledWith({
      attempt: "primary",
      text: "Pancakes: 2 eggs, 1 cup flour, fry."
    });
  });
});
