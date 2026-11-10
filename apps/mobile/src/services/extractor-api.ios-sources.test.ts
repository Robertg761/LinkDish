import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extractRecipe: vi.fn(),
  extractRecipeFromText: vi.fn(),
  consent: vi.fn(),
  track: vi.fn()
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../analytics/client", () => ({
  getMobileAnalyticsHeaders: () => Promise.resolve({}),
  trackMobileEvent: mocks.track
}));
vi.mock("../config/env", () => ({
  mobileEnv: { apiBaseUrl: "https://api.example.com", useMockApi: false }
}));
vi.mock("../features/privacy/ai-consent", () => ({ requireAiConsent: mocks.consent }));
vi.mock("@linkdish/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClientModule>()),
  createExtractorApiClient: () => mocks
}));

import { extractRecipe } from "./extractor-api";

import type * as ApiClientModule from "@linkdish/api-client";

describe("iPhone source enforcement at the extraction boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractRecipe.mockResolvedValue({
      status: "failure",
      reason: "parse_failed",
      userMessage: "fixture"
    });
    mocks.extractRecipeFromText.mockResolvedValue({
      status: "failure",
      reason: "parse_failed",
      userMessage: "fixture"
    });
  });

  it("blocks direct/deep links and both retry attempts before consent, analytics or API calls", async () => {
    for (const attempt of ["primary", "fallback"] as const) {
      expect(await extractRecipe("https://unapproved.example/recipe", attempt)).toMatchObject({
        status: "failure",
        reason: "unsupported_source"
      });
      expect(
        await extractRecipe({ url: "https://unapproved.example/recipe", attempt })
      ).toMatchObject({ status: "failure", reason: "unsupported_source" });
    }
    expect(mocks.consent).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
    expect(mocks.extractRecipe).not.toHaveBeenCalled();
  });

  it("sends an approved recipe through the existing consent and extraction flow", async () => {
    const url = "https://publicdomainrecipes.com/basic-waffles/";
    await extractRecipe(url);
    expect(mocks.consent).toHaveBeenCalledOnce();
    expect(mocks.extractRecipe).toHaveBeenCalledWith({ url, attempt: "primary" });
  });

  it("keeps user-supplied photos and text available with AI consent", async () => {
    const photo = {
      attempt: "fallback" as const,
      sourceUrl: "https://linkdish.app/image-imports/1",
      images: [{ mimeType: "image/jpeg" as const, dataUrl: "data:image/jpeg;base64,aGVsbG8=" }]
    };
    await extractRecipe(photo);
    await extractRecipe({
      attempt: "primary",
      routeUrl: "https://linkdish.app/text-imports/1",
      text: "My recipe"
    });
    expect(mocks.consent).toHaveBeenCalledTimes(2);
    expect(mocks.extractRecipe).toHaveBeenCalledWith(photo);
    expect(mocks.extractRecipeFromText).toHaveBeenCalledWith({
      attempt: "primary",
      text: "My recipe"
    });
  });

  it("refuses a successful result whose source redirected to an unapproved host", async () => {
    mocks.extractRecipe.mockResolvedValueOnce({
      status: "success",
      recipe: { sourceUrl: "https://unapproved.example/recipe" }
    });
    expect(await extractRecipe("https://publicdomainrecipes.com/basic-waffles/")).toMatchObject({
      status: "failure",
      reason: "unsupported_source"
    });
    expect(mocks.extractRecipe).toHaveBeenCalledOnce();
  });
});
