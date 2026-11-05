import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  extractRecipe: vi.fn(),
  extractRecipeFromDevicePage: vi.fn(),
  extractRecipeFromText: vi.fn()
}));
const deviceMocks = vi.hoisted(() => ({ fetchPageOnDevice: vi.fn() }));

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

vi.mock("./device-page-fetch", () => deviceMocks);

import { extractRecipe } from "./extractor-api";

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
    deviceMocks.fetchPageOnDevice.mockReset();
  });

  it("downloads the page on the phone and sends it to be read", async () => {
    deviceMocks.fetchPageOnDevice.mockResolvedValue({ html: "<html>soup</html>", finalUrl: url });

    const response = await extractRecipe({ url, attempt: "primary", correlationId: "import-1" });

    expect(deviceMocks.fetchPageOnDevice).toHaveBeenCalledWith(url);
    expect(clientMocks.extractRecipeFromDevicePage).toHaveBeenCalledWith({
      url,
      attempt: "primary",
      correlationId: "import-1",
      devicePage: { html: "<html>soup</html>", finalUrl: url }
    });
    expect(response).toBe(fromDevice);
  });

  it("points to Paste text when the phone is turned away too", async () => {
    deviceMocks.fetchPageOnDevice.mockResolvedValue(null);

    const response = await extractRecipe({ url, attempt: "primary" });

    expect(clientMocks.extractRecipeFromDevicePage).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      status: "failure",
      reason: "source_blocked",
      userMessage: expect.stringContaining("allrecipes.com wouldn't open for LinkDish") as string
    });
  });

  it("leaves a block alone when the API does not offer a device download", async () => {
    const plainBlock = { ...blocked, deviceFetchAvailable: undefined };
    clientMocks.extractRecipe.mockResolvedValue(plainBlock);

    const response = await extractRecipe({ url, attempt: "primary" });

    expect(deviceMocks.fetchPageOnDevice).not.toHaveBeenCalled();
    expect(response).toEqual(plainBlock);
  });
});
