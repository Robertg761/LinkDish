import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  extractRecipe: vi.fn(),
  extractRecipeFromDevicePage: vi.fn(),
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

import { canOpenBlockedPage, extractRecipe } from "./extractor-api";

import type * as ApiClientModule from "@linkdish/api-client";

const url = "https://www.allrecipes.com/recipe/13309/rich-and-simple-french-onion-soup/";
const blocked = {
  status: "failure",
  reason: "source_blocked",
  userMessage: "That site blocks LinkDish's servers from reading its pages.",
  deviceFetchAvailable: true,
  recovery: { retryable: false, allowFallback: false, suggestedAction: "try_another_url" }
} as const;
const fromDevice = { status: "failure", reason: "parse_failed", userMessage: "Read it." } as const;

describe("extractRecipe for a site that blocks LinkDish's servers", () => {
  beforeEach(() => {
    clientMocks.extractRecipe.mockReset().mockResolvedValue(blocked);
    clientMocks.extractRecipeFromDevicePage.mockReset().mockResolvedValue(fromDevice);
  });

  it("never downloads the page itself; it offers to open it, naming the site", async () => {
    const response = await extractRecipe({ url, attempt: "primary" });

    expect(clientMocks.extractRecipeFromDevicePage).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      status: "failure",
      reason: "source_blocked",
      userMessage: expect.stringContaining("allrecipes.com blocks LinkDish's servers") as string
    });
    expect(canOpenBlockedPage({ url, attempt: "primary" }, response)).toBe(true);
  });

  it("names a Facebook-wrapped link's own site", async () => {
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(url)}&h=abc`;

    const response = await extractRecipe({ url: wrapped, attempt: "primary" });

    expect(response).toMatchObject({
      userMessage: expect.stringContaining("allrecipes.com blocks") as string
    });
  });

  it("sends a page the person saved to be read", async () => {
    const devicePage = { html: "<html>soup</html>", finalUrl: url };

    const response = await extractRecipe({
      url,
      attempt: "primary",
      correlationId: "import-1",
      devicePage
    });

    expect(clientMocks.extractRecipe).not.toHaveBeenCalled();
    expect(clientMocks.extractRecipeFromDevicePage).toHaveBeenCalledWith({
      url,
      attempt: "primary",
      correlationId: "import-1",
      devicePage
    });
    expect(response).toBe(fromDevice);
  });

  it("does not offer the page again when a saved page was itself refused", async () => {
    clientMocks.extractRecipeFromDevicePage.mockResolvedValue(blocked);
    const request = { url, attempt: "primary" as const, devicePage: { html: "<p>x</p>" } };

    const response = await extractRecipe(request);

    expect(canOpenBlockedPage(request, response)).toBe(false);
    expect(response).toEqual(blocked);
  });

  it("leaves a block alone when the API does not offer a page from the phone", async () => {
    const plainBlock = { ...blocked, deviceFetchAvailable: undefined };
    clientMocks.extractRecipe.mockResolvedValue(plainBlock);

    const response = await extractRecipe({ url, attempt: "primary" });

    expect(response).toEqual(plainBlock);
    expect(canOpenBlockedPage({ url, attempt: "primary" }, response)).toBe(false);
  });
});
