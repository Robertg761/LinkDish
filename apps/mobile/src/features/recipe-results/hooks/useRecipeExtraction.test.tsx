import AsyncStorage from "@react-native-async-storage/async-storage";
import React from "react";
import { Text } from "react-native";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios"
  },
  Text: ({ children }: { children: React.ReactNode }) => React.createElement("text", null, children)
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000001")
}));

vi.mock("../../../services/extractor-api", () => ({
  extractRecipe: vi.fn()
}));

vi.mock("../../../analytics/client", () => ({
  createMobileAnalyticsId: vi.fn(() => "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"),
  trackMobileEvent: vi.fn()
}));

const mockAccountState = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  hasLoadedAccount: true,
  isSignedIn: false,
  sessionToken: null as string | null,
  user: null
}));

const upgradeMomentMocks = vi.hoisted(() => ({
  showUpgradeMoment: vi.fn()
}));

vi.mock("../../account/AccountContext", () => ({
  useAccount: () => mockAccountState
}));

vi.mock("../../billing/UpgradeMomentContext", () => ({
  useOptionalUpgradeMoment: () => upgradeMomentMocks
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined)
  }
}));

import { trackMobileEvent } from "../../../analytics/client";
import { extractRecipe } from "../../../services/extractor-api";
import { BillingProvider } from "../../billing/BillingContext";
import { getBillingPeriodKey } from "../../billing/store";
import { createSavedRecipeRecord } from "../../saved-recipes/store";

import { useRecipeExtraction } from "./useRecipeExtraction";

import type { ExtractRecipeRequest } from "@linkdish/api-contracts";

const mockedExtractRecipe = vi.mocked(extractRecipe);
const mockedAsyncStorage = vi.mocked(AsyncStorage);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HookProbeBody = ({ url }: { url?: string | undefined }) => {
  const { state } = useRecipeExtraction(url);
  return <Text>{JSON.stringify(state)}</Text>;
};

const HookRequestProbeBody = ({ request }: { request: ExtractRecipeRequest }) => {
  const { state } = useRecipeExtraction(request);
  return <Text>{JSON.stringify(state)}</Text>;
};

const HookProbe = ({ url }: { url?: string | undefined }) => (
  <BillingProvider>
    <HookProbeBody url={url} />
  </BillingProvider>
);

const HookRequestProbe = ({ request }: { request: ExtractRecipeRequest }) => (
  <BillingProvider>
    <HookRequestProbeBody request={request} />
  </BillingProvider>
);

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("useRecipeExtraction", () => {
  beforeEach(() => {
    mockAccountState.getAuthToken.mockReset();
    mockAccountState.getAuthToken.mockResolvedValue(null);
    mockAccountState.hasLoadedAccount = true;
    mockAccountState.isSignedIn = false;
    mockAccountState.sessionToken = null;
    mockAccountState.user = null;
    mockedExtractRecipe.mockReset();
    vi.mocked(trackMobileEvent).mockClear();
    mockedAsyncStorage.getItem.mockReset();
    mockedAsyncStorage.setItem.mockReset();
    mockedAsyncStorage.getItem.mockResolvedValue(null);
    mockedAsyncStorage.setItem.mockResolvedValue(undefined);
  });

  it("automatically tries fallback when the primary extraction asks for more help", async () => {
    mockedExtractRecipe
      .mockResolvedValueOnce({
        status: "needs_retry",
        reason: "low_confidence",
        sourceType: "article",
        suggestedAttempt: "fallback",
        userMessage: "Try again with more help.",
        diagnostics: {
          confidenceScore: 0.52,
          missingFields: ["cookTimeMinutes"]
        },
        recovery: {
          retryable: true,
          allowFallback: true,
          suggestedAction: "retry_fallback"
        }
      })
      .mockResolvedValueOnce({
        status: "success",
        recipe: {
          title: "Recovered Soup",
          sourceUrl: "https://example.com/retry",
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
              title: "llm",
              ingredients: "llm",
              steps: "llm",
              servings: "llm",
              prepTimeMinutes: "llm",
              cookTimeMinutes: "llm",
              nutrition: null
            }
          }
        },
        extraction: {
          sourceType: "article",
          strategy: "llm-fallback",
          confidenceScore: 0.81,
          missingFields: [],
          warnings: [],
          fetchMode: "http",
          provenance: ["llm", "visible-text"]
        }
      });

    let renderer: ReturnType<typeof create>;

    await act(() => {
      renderer = create(<HookProbe url="https://example.com/retry" />);
      return Promise.resolve();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    const output = renderer!.root.findByType(Text).props.children as string;
    expect(output).toContain('"state":"success"');
    expect(output).toContain("Recovered Soup");
    expect(mockedExtractRecipe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://example.com/retry",
        attempt: "primary"
      }),
      expect.any(Object)
    );
    expect(mockedExtractRecipe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://example.com/retry",
        attempt: "fallback"
      }),
      expect.any(Object)
    );
    const primaryRequest = mockedExtractRecipe.mock.calls[0]?.[0];
    const fallbackRequest = mockedExtractRecipe.mock.calls[1]?.[0];
    expect(primaryRequest?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(fallbackRequest?.correlationId).toBe(primaryRequest?.correlationId);
    expect(
      vi
        .mocked(trackMobileEvent)
        .mock.calls.filter(([event]) => event.eventName === "import_started")
    ).toHaveLength(1);
    expect(
      vi
        .mocked(trackMobileEvent)
        .mock.calls.filter(([event]) => event.eventName === "import_succeeded")
        .at(0)?.[0].correlationId
    ).toBe(primaryRequest?.correlationId);
  });

  it("enters a success state when extraction succeeds", async () => {
    mockedExtractRecipe.mockResolvedValueOnce({
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
        provenance: ["readability", "visible-text"]
      }
    });

    let renderer: ReturnType<typeof create>;

    await act(() => {
      renderer = create(<HookProbe url="https://example.com/soup" />);
      return Promise.resolve();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    const output = renderer!.root.findByType(Text).props.children as string;
    expect(output).toContain('"state":"success"');
    expect(trackMobileEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "import_succeeded",
        properties: expect.objectContaining({
          source_type: "url",
          strategy: "article-pattern"
        }) as Record<string, unknown>
      })
    );
  });

  it("lets signed-in users rely on server billing so household quota can apply", async () => {
    mockAccountState.isSignedIn = true;
    mockAccountState.sessionToken = "session-token";
    mockAccountState.getAuthToken.mockResolvedValue("session-token");
    mockedAsyncStorage.getItem.mockImplementation((key) =>
      Promise.resolve(
        key === "linkdish.billing"
          ? JSON.stringify({
              tier: "free",
              usage: {
                imports: 10,
                periodKey: getBillingPeriodKey(),
                strongExtractions: 10
              },
              usageAccountingVersion: 2
            })
          : null
      )
    );
    mockedExtractRecipe.mockResolvedValueOnce({
      status: "success",
      recipe: {
        title: "Household Soup",
        sourceUrl: "https://example.com/household",
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
        provenance: ["readability", "visible-text"]
      }
    });

    let renderer: ReturnType<typeof create>;

    await act(() => {
      renderer = create(<HookProbe url="https://example.com/household" />);
      return Promise.resolve();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    const output = renderer!.root.findByType(Text).props.children as string;
    expect(output).toContain('"state":"success"');
    expect(mockedExtractRecipe).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/household",
        attempt: "primary"
      }),
      expect.objectContaining({
        authToken: "session-token"
      })
    );
  });

  it("starts image imports with fallback extraction", async () => {
    mockedExtractRecipe.mockResolvedValueOnce({
      status: "success",
      recipe: {
        title: "Scanned Soup",
        sourceUrl: "https://linkdish.app/image-imports/test",
        sourceType: "image",
        ingredients: [{ text: "1 onion" }],
        steps: [{ index: 1, text: "Cook." }],
        servings: "4 servings",
        prepTimeMinutes: 10,
        cookTimeMinutes: 20,
        nutrition: null,
        confidence: {
          score: 0.81,
          summary: "Confident image extraction.",
          missingFields: [],
          notes: [],
          fieldProvenance: {
            title: "llm",
            ingredients: "llm",
            steps: "llm",
            servings: "llm",
            prepTimeMinutes: "llm",
            cookTimeMinutes: "llm",
            nutrition: null
          }
        }
      },
      extraction: {
        sourceType: "image",
        strategy: "llm-fallback",
        confidenceScore: 0.81,
        missingFields: [],
        warnings: [],
        fetchMode: "http",
        provenance: ["llm"]
      }
    });

    const request: ExtractRecipeRequest = {
      images: [
        {
          dataUrl: "data:image/jpeg;base64,abc123",
          mimeType: "image/jpeg"
        }
      ],
      sourceUrl: "https://linkdish.app/image-imports/test",
      attempt: "fallback"
    };
    let renderer: ReturnType<typeof create>;

    await act(() => {
      renderer = create(<HookRequestProbe request={request} />);
      return Promise.resolve();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    const output = renderer!.root.findByType(Text).props.children as string;
    expect(output).toContain('"state":"success"');
    expect(output).toContain('"sourceImages"');
    expect(output).toContain("data:image/jpeg;base64,abc123");
    expect(mockedExtractRecipe).toHaveBeenCalledWith(
      expect.objectContaining(request),
      expect.any(Object)
    );
  });

  it("restores a draft extraction without spending another API request", async () => {
    const savedRecipe = createSavedRecipeRecord(
      {
        state: "success",
        recipe: {
          title: "Draft Soup",
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
        strategy: "article-pattern",
        warnings: [],
        fetchMode: "http",
        provenance: ["readability", "visible-text"]
      },
      "2026-04-19T12:00:00.000Z"
    );
    const legacySavedRecipe: Partial<typeof savedRecipe> = { ...savedRecipe };
    delete legacySavedRecipe.id;
    mockedAsyncStorage.getItem.mockImplementation((key) =>
      Promise.resolve(
        key === "linkdish.draftRecipeExtractions"
          ? JSON.stringify([
              {
                requestedUrl: "https://example.com/original",
                savedRecipe: legacySavedRecipe,
                updatedAt: "2026-04-19T12:01:00.000Z"
              }
            ])
          : null
      )
    );

    let renderer: ReturnType<typeof create>;

    await act(() => {
      renderer = create(<HookProbe url="https://example.com/original" />);
      return Promise.resolve();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    const output = renderer!.root.findByType(Text).props.children as string;
    expect(output).toContain('"state":"success"');
    expect(output).toContain("Draft Soup");
    expect(mockedExtractRecipe).not.toHaveBeenCalled();
  });

  it("shows a friendly transport error message when the API is unreachable", async () => {
    mockedExtractRecipe.mockRejectedValueOnce(new Error("Network request failed"));

    let renderer: ReturnType<typeof create>;

    await act(() => {
      renderer = create(<HookProbe url="https://example.com/offline" />);
      return Promise.resolve();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    const output = renderer!.root.findByType(Text).props.children as string;
    expect(output).toContain('"state":"failure"');
    expect(output).toContain("LinkDish could not reach the extraction service");
    expect(trackMobileEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "import_failed",
        properties: expect.objectContaining({
          failure_reason: "transport_error",
          source_type: "url"
        }) as Record<string, unknown>
      })
    );
  });

  it("records an abandoned terminal state when an in-flight import leaves the screen", async () => {
    mockedExtractRecipe.mockImplementationOnce(() => new Promise(() => undefined));

    let renderer: ReturnType<typeof create>;

    await act(() => {
      renderer = create(<HookProbe url="https://example.com/slow" />);
      return Promise.resolve();
    });

    await act(async () => {
      await flushAsyncWork();
    });

    const submittedRequest = mockedExtractRecipe.mock.calls[0]?.[0];
    expect(submittedRequest?.correlationId).toBeTruthy();

    await act(() => {
      renderer!.unmount();
      return Promise.resolve();
    });

    expect(trackMobileEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: submittedRequest?.correlationId,
        eventName: "import_abandoned",
        properties: expect.objectContaining({
          abandonment_reason: "screen_or_source_changed"
        }) as Record<string, unknown>
      })
    );
  });
});
