import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { enqueueImport, resetImportQueueStoreForTests } from "../../data/import-queue-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import {
  getLinkDishWebDb,
  IMPORT_QUEUE_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { ExtractPage } from "./ExtractPage";

import type { ImportQueueItem } from "../../data/import-queue-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeRequest, ExtractRecipeTextRequestInput } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const apiMocks = vi.hoisted(() => {
  class ExtractorApiError extends Error {
    public readonly kind = "http";

    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown
    ) {
      super(message);
      this.name = "ExtractorApiError";
    }
  }

  return {
    ExtractorApiError,
    extractRecipe:
      vi.fn<
        (request: ExtractRecipeRequest, options?: { signal?: AbortSignal }) => Promise<unknown>
      >(),
    extractRecipeFromText:
      vi.fn<
        (
          request: ExtractRecipeTextRequestInput,
          options?: { signal?: AbortSignal }
        ) => Promise<unknown>
      >(),
    getBillingUsage: vi.fn(),
    getHousehold: vi.fn()
  };
});

vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: {
    extractRecipe: apiMocks.extractRecipe,
    extractRecipeFromText: apiMocks.extractRecipeFromText,
    getBillingUsage: apiMocks.getBillingUsage,
    getHousehold: apiMocks.getHousehold
  },
  ExtractorApiError: apiMocks.ExtractorApiError,
  isExtractorApiError: (error: unknown) => error instanceof apiMocks.ExtractorApiError
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: vi.fn(),
  trackWebV2AnalyticsEvent: vi.fn()
}));

const authMocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();

  return {
    /** False while a cached Clerk user's session is still loading. */
    credentialsReady: true,
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    user: { billingPlan: "free", email: "cook@example.com", id: "user_1" } as {
      billingPlan?: "free" | "plus" | "family";
      email: string;
      id: string;
    } | null,
    version: 0
  };
});

const setCredentialsReady = (ready: boolean) => {
  authMocks.credentialsReady = ready;
  authMocks.version += 1;
  authMocks.listeners.forEach((listener) => listener());
};

vi.mock("../../auth/AuthProvider", async () => {
  const { useSyncExternalStore } = await import("react");

  return {
    useAuth: () => {
      useSyncExternalStore(authMocks.subscribe, () => authMocks.version);

      return {
        credentialsKey: authMocks.credentialsReady ? `session:${authMocks.user?.id ?? ""}` : null,
        credentialsReady: authMocks.credentialsReady,
        isAuthenticated: Boolean(authMocks.user),
        loading: false,
        user: authMocks.user
      };
    }
  };
});

const upgradeMocks = vi.hoisted(() => ({ requestUpgradeSheet: vi.fn(() => true) }));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: upgradeMocks.requestUpgradeSheet })
}));

const networkMocks = vi.hoisted(() => ({ online: true }));

vi.mock("../../platform/detect-network", () => ({
  addNetworkListeners: () => () => undefined,
  isOnline: () => networkMocks.online
}));

const recipe: Recipe = {
  confidence: {
    fieldProvenance: {
      cookTimeMinutes: "jsonld",
      ingredients: "jsonld",
      nutrition: null,
      prepTimeMinutes: "jsonld",
      servings: "jsonld",
      steps: "jsonld",
      title: "jsonld"
    },
    missingFields: [],
    notes: [],
    score: 0.95,
    summary: "High confidence"
  },
  cookTimeMinutes: 20,
  image: null,
  ingredients: [{ text: "1 cup rice" }, { text: "2 cups water" }],
  nutrition: null,
  prepTimeMinutes: 5,
  servings: "4 servings",
  sourceType: "recipe-webpage",
  sourceUrl: "https://example.com/rice",
  steps: [{ index: 1, text: "Cook the rice." }],
  title: "Weeknight Rice"
};

const success = (extra: Record<string, unknown> = {}) => ({
  extraction: {
    confidenceScore: 0.95,
    fetchMode: "http",
    missingFields: [],
    provenance: ["jsonld"],
    sourceType: "recipe-webpage",
    strategy: "recipe-schema",
    warnings: []
  },
  recipe,
  status: "success",
  ...extra
});

const needsRetry = (sourceType = "article") => ({
  diagnostics: { confidenceScore: 0.4, missingFields: ["ingredients"] },
  reason: "low_confidence",
  recovery: { allowFallback: true, retryable: true, suggestedAction: "retry_fallback" },
  sourceType,
  status: "needs_retry",
  suggestedAttempt: "fallback",
  userMessage: "Try a deeper extraction."
});

const savedRecord = (overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => ({
  createdAt: "2026-09-01T12:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  id: "saved-soup",
  recipe: { ...recipe, sourceUrl: "https://www.example.com/soup", title: "Tomato Soup" },
  sourceHost: "example.com",
  sourceUrl: "https://www.example.com/soup",
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-09-01T12:00:00.000Z",
  ...overrides
});

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
};

/** Stands in for the command palette and onboarding: in-app links to the importer. */
const InAppLink: React.FC<{ to: string }> = ({ to }) => {
  const navigate = useNavigate();
  return (
    <button onClick={() => void navigate(to)} type="button">
      {`Go to ${to}`}
    </button>
  );
};

const renderPage = (path = "/import", inAppLinks: readonly string[] = []) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          element={
            <>
              <LocationProbe />
              {inAppLinks.map((to) => (
                <InAppLink key={to} to={to} />
              ))}
              <ExtractPage />
            </>
          }
          path="/import"
        />
        <Route element={<p>Recipe page</p>} path="/recipes/:id" />
      </Routes>
    </MemoryRouter>
  );

const pasteLink = (url: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Recipe link" }), {
    target: { value: url }
  });
  fireEvent.click(
    screen.getByRole("button", { name: /^(Get the recipe|Save for when you’re online)$/u })
  );
};

const v2Events = (name: string) =>
  vi.mocked(trackWebV2AnalyticsEvent).mock.calls.filter(([event]) => event.name === name);

const startedEvents = () =>
  vi.mocked(trackWebEvent).mock.calls.filter(([event]) => event.eventName === "import_started");

describe("ExtractPage", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    localStorage.clear();
    sessionStorage.clear();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    resetImportQueueStoreForTests();
    setDataChannelFactoryForTests(() => null);
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
    localStorage.setItem("linkdish:web:starter-recipes-seeded:v1", "true");
    await getLinkDishWebDb();

    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };
    authMocks.credentialsReady = true;
    networkMocks.online = true;
    upgradeMocks.requestUpgradeSheet.mockClear();
    vi.mocked(trackWebEvent).mockClear();
    vi.mocked(trackWebV2AnalyticsEvent).mockClear();
    apiMocks.extractRecipe.mockReset();
    apiMocks.extractRecipeFromText.mockReset();
    apiMocks.getBillingUsage.mockReset();
    apiMocks.getBillingUsage.mockResolvedValue({ billingEnabled: false, plan: null, quota: null });
    apiMocks.getHousehold.mockReset();
    apiMocks.getHousehold.mockResolvedValue({ household: null });
    apiMocks.extractRecipe.mockResolvedValue({
      reason: "parse_failed",
      status: "failure",
      userMessage: "No recipe could be found at that link."
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports a link with one correlation id from import_started to import_failed", async () => {
    renderPage();
    pasteLink("example.com/recipe).");

    expect(await screen.findByRole("heading", { name: "No recipe on that page" })).toBeVisible();

    const request = apiMocks.extractRecipe.mock.calls[0]?.[0];
    expect(request).toMatchObject({ attempt: "primary", url: "https://example.com/recipe" });
    expect(startedEvents()).toHaveLength(1);
    expect(startedEvents()[0]?.[0]).toMatchObject({
      correlationId: request?.correlationId,
      properties: { source: "in_app", source_type: "url" }
    });
    expect(v2Events("import_failed")).toHaveLength(1);
    expect(v2Events("import_failed")[0]?.[0]).toMatchObject({
      correlationId: request?.correlationId,
      properties: { failure_reason: "parse_failed", source_type: "url" }
    });
    expect(screen.getByRole("button", { name: "Paste the recipe text" })).toBeInTheDocument();
  });

  it("keeps one correlation id when the cook asks for AI help", async () => {
    apiMocks.extractRecipe
      .mockResolvedValueOnce(needsRetry())
      .mockResolvedValueOnce({ reason: "fallback_failed", status: "failure", userMessage: "Nope" });
    renderPage();
    pasteLink("https://example.com/recipe");

    expect(await screen.findByRole("heading", { name: "We found part of a recipe" })).toBeVisible();
    expect(screen.queryByText(/confidence/iu)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try with AI help" }));

    await waitFor(() => expect(apiMocks.extractRecipe).toHaveBeenCalledTimes(2));
    const [primary, fallback] = apiMocks.extractRecipe.mock.calls.map(([request]) => request);
    expect(fallback).toMatchObject({ attempt: "fallback" });
    expect(fallback?.correlationId).toBe(primary?.correlationId);
    expect(startedEvents()).toHaveLength(1);
    expect(v2Events("import_needs_retry")[0]?.[0].correlationId).toBe(primary?.correlationId);
    await screen.findByRole("heading", { name: "That one got away" });
    expect(v2Events("import_failed")).toHaveLength(1);
  });

  it("runs AI help by itself for social captions, on the same correlation id", async () => {
    apiMocks.extractRecipe
      .mockResolvedValueOnce(needsRetry("social"))
      .mockResolvedValueOnce(success());
    renderPage();
    pasteLink("https://www.tiktok.com/@cook/video/123");

    expect(await screen.findByRole("heading", { level: 1, name: "Weeknight Rice" })).toBeVisible();
    const [primary, fallback] = apiMocks.extractRecipe.mock.calls.map(([request]) => request);
    expect(fallback).toMatchObject({ attempt: "fallback", correlationId: primary?.correlationId });
    expect(startedEvents()).toHaveLength(1);
    expect(v2Events("import_succeeded")).toHaveLength(1);
    expect(v2Events("import_succeeded")[0]?.[0].properties).toMatchObject({ attempt: "fallback" });
  });

  it("runs AI help by itself on paid plans", async () => {
    authMocks.user = { billingPlan: "plus", email: "cook@example.com", id: "user_1" };
    apiMocks.extractRecipe.mockResolvedValueOnce(needsRetry()).mockResolvedValueOnce(success());
    renderPage();
    pasteLink("https://example.com/recipe");

    await screen.findByRole("heading", { level: 1, name: "Weeknight Rice" });
    expect(apiMocks.extractRecipe).toHaveBeenCalledTimes(2);
  });

  it("cancels for real: the request is aborted and import_cancelled is recorded once", async () => {
    let signal: AbortSignal | undefined;
    apiMocks.extractRecipe.mockImplementation(
      (_request, options) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          );
        })
    );
    renderPage();
    pasteLink("https://example.com/slow");

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(signal?.aborted).toBe(true);
    expect(await screen.findByRole("textbox", { name: "Recipe link" })).toBeVisible();
    expect(v2Events("import_cancelled")).toHaveLength(1);
    expect(v2Events("import_cancelled")[0]?.[0].properties).toMatchObject({
      cancellation_reason: "user_cancelled"
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(v2Events("import_failed")).toHaveLength(0);
  });

  it("records abandonment once and ignores a late answer after leaving", async () => {
    let resolveExtraction: ((response: unknown) => void) | undefined;
    let signal: AbortSignal | undefined;
    apiMocks.extractRecipe.mockImplementationOnce(
      (_request, options) =>
        new Promise((resolve) => {
          signal = options?.signal;
          resolveExtraction = resolve;
        })
    );
    const view = renderPage();
    pasteLink("https://example.com/slow-recipe");
    await waitFor(() => expect(apiMocks.extractRecipe).toHaveBeenCalledOnce());

    view.unmount();

    expect(signal?.aborted).toBe(true);
    expect(v2Events("import_abandoned")).toHaveLength(1);
    expect(v2Events("import_abandoned")[0]?.[0].properties).toMatchObject({
      abandonment_reason: "page_unmounted"
    });

    await act(async () => {
      resolveExtraction?.({ reason: "parse_failed", status: "failure", userMessage: "Late" });
      await Promise.resolve();
    });
    expect(v2Events("import_failed")).toHaveLength(0);
  });

  it("finds a recipe that's already saved before spending an import", async () => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [savedRecord()]);
    apiMocks.extractRecipe.mockResolvedValue(success());
    renderPage();
    pasteLink("example.com/soup?utm_source=pinterest");

    expect(await screen.findByRole("heading", { name: "Already in your cookbook" })).toBeVisible();
    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect(startedEvents()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Import again" }));
    await waitFor(() => expect(apiMocks.extractRecipe).toHaveBeenCalledOnce());
    expect(startedEvents()).toHaveLength(1);
  });

  it("treats the AI provider running out of capacity as a pause, not the plan limit", async () => {
    apiMocks.extractRecipe.mockResolvedValue({
      reason: "quota_exceeded",
      recovery: { allowFallback: false, retryable: true, suggestedAction: "try_again_later" },
      status: "failure",
      userMessage: "Extra recipe help is temporarily unavailable."
    });
    renderPage();
    pasteLink("https://example.com/recipe");

    expect(await screen.findByText(/isn't your plan limit/u)).toBeVisible();
    expect(upgradeMocks.requestUpgradeSheet).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "See plans" })).not.toBeInTheDocument();
  });

  it("offers plans when the account's allowance is used up", async () => {
    apiMocks.extractRecipe.mockResolvedValue({
      quota: {
        limit: 3,
        meteringMode: "free_lifetime",
        monthlyLimit: null,
        remaining: 0,
        remainingThisMonth: null,
        resetsAt: null
      },
      reason: "plan_limit",
      status: "failure",
      userMessage: "You have used your free imports."
    });
    renderPage();
    pasteLink("https://example.com/recipe");

    expect(await screen.findByRole("link", { name: "See plans" })).toHaveAttribute(
      "href",
      "/pricing"
    );
    expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("import_limit");
    expect(screen.getByText("0 of 3 free imports left")).toBeInTheDocument();
  });

  it("stops at the on-device allowance for signed-out cooks without calling the API", async () => {
    authMocks.user = null;
    localStorage.setItem(
      "linkdish:web:billing-usage:v2",
      JSON.stringify({ imports: 3, monthKey: "2026-09", strongExtractions: 0 })
    );
    renderPage();
    pasteLink("https://example.com/recipe");

    expect(
      await screen.findByRole("heading", { name: "You've used your free imports" })
    ).toBeVisible();
    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("import_limit");
  });

  it("starts a shared link once and clears it from the address bar", async () => {
    apiMocks.extractRecipe.mockResolvedValue(success());
    renderPage(`/import?text=${encodeURIComponent("Look at this! https://example.com/rice).")}`);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/import$/u));
    await screen.findByRole("heading", { level: 1, name: "Weeknight Rice" });
    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect(apiMocks.extractRecipe.mock.calls[0]?.[0]).toMatchObject({
      url: "https://example.com/rice"
    });
    expect(startedEvents()[0]?.[0].properties).toMatchObject({
      source: "share_sheet",
      source_type: "share_target"
    });
  });

  it("waits for the account's credentials before starting a shared link", async () => {
    // Cold start from the share sheet with a cached Clerk user whose session is still loading.
    authMocks.user = { billingPlan: "plus", email: "cook@example.com", id: "user_1" };
    authMocks.credentialsReady = false;
    apiMocks.extractRecipe.mockResolvedValue(success());
    renderPage(`/import?url=${encodeURIComponent("https://example.com/rice")}`);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/import$/u));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Nothing goes out anonymously (it would be billed to the device, not the Plus account).
    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect(apiMocks.getBillingUsage).not.toHaveBeenCalled();

    act(() => {
      setCredentialsReady(true);
    });

    await screen.findByRole("heading", { level: 1, name: "Weeknight Rice" });
    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect(apiMocks.getBillingUsage).toHaveBeenCalled();
  });

  it("holds the import queue until the account's credentials are ready", async () => {
    authMocks.credentialsReady = false;
    apiMocks.extractRecipe.mockResolvedValue(success());
    await enqueueImport({ source: "share_sheet", url: "https://example.com/rice" });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Import queue" })).toBeVisible();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();

    act(() => {
      setCredentialsReady(true);
    });

    await waitFor(() => expect(apiMocks.extractRecipe).toHaveBeenCalledOnce());
  });

  it("imports a link from an in-app link while the importer is already open", async () => {
    apiMocks.extractRecipe.mockResolvedValue(success());
    const link = `/import?url=${encodeURIComponent("https://example.com/rice")}`;
    renderPage("/import", [link]);

    // The command palette ("Import this recipe") and onboarding navigate /import → /import?url=.
    fireEvent.click(screen.getByRole("button", { name: `Go to ${link}` }));

    await screen.findByRole("heading", { level: 1, name: "Weeknight Rice" });
    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect(apiMocks.extractRecipe.mock.calls[0]?.[0]).toMatchObject({
      url: "https://example.com/rice"
    });
    expect(startedEvents()[0]?.[0].properties).toMatchObject({ source: "in_app" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/import$/u));
  });

  it("opens the text and photo tabs from ?tab= links, also when already on /import", async () => {
    renderPage("/import?tab=text", ["/import?tab=photos"]);

    expect(screen.getByRole("radio", { name: "Text" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/import$/u));

    fireEvent.click(screen.getByRole("button", { name: "Go to /import?tab=photos" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Photos" })).toHaveAttribute("aria-checked", "true")
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Snap the page.");
  });

  it("names the site that failed and offers one way back, not two", async () => {
    apiMocks.extractRecipe.mockResolvedValue({
      reason: "source_blocked",
      status: "failure",
      userMessage: "Blocked."
    });
    renderPage();
    pasteLink("https://www.nytimes.com/recipe/soup");

    const card = await screen.findByRole("alert");
    expect(card).toHaveTextContent("nytimes.com");
    expect(Array.from(card.querySelectorAll("button")).map((button) => button.textContent)).toEqual(
      ["Paste the recipe text", "Scan a photo instead", "Try another link"]
    );
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
  });

  it("imports pasted text through AI help", async () => {
    apiMocks.extractRecipeFromText.mockResolvedValue(success());
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Paste the recipe. We'll tidy it up."
    );
    const field = screen.getByRole("textbox", { name: "Recipe text" });
    fireEvent.change(field, { target: { value: "too short" } });
    fireEvent.click(screen.getByRole("button", { name: "Get the recipe" }));
    expect(await screen.findByText(/at least 20 characters/u)).toBeVisible();
    expect(apiMocks.extractRecipeFromText).not.toHaveBeenCalled();

    const text = "Rice\n1 cup rice\n2 cups water\nSimmer for 18 minutes, covered.";
    fireEvent.change(field, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Get the recipe" }));

    await screen.findByRole("heading", { level: 1, name: "Weeknight Rice" });
    expect(apiMocks.extractRecipeFromText.mock.calls[0]?.[0]).toMatchObject({
      attempt: "fallback",
      text
    });
    expect(startedEvents()[0]?.[0].properties).toMatchObject({
      attempt: "fallback",
      source_type: "text"
    });
  });

  it("queues links shared while offline instead of failing", async () => {
    networkMocks.online = false;
    renderPage();
    pasteLink("https://example.com/for-later");

    expect(await screen.findByRole("heading", { name: "Saved for later" })).toBeVisible();
    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(trackWebEvent)
        .mock.calls.some(([event]) => event.eventName === "import_queued_offline")
    ).toBe(true);
    const queued = fakeIdb.records<ImportQueueItem>(IMPORT_QUEUE_STORE_NAME);
    expect(queued).toEqual([
      expect.objectContaining({
        source: "in_app",
        status: "queued",
        url: "https://example.com/for-later"
      })
    ]);
  });

  it("adds several pasted links to the import queue", async () => {
    networkMocks.online = false;
    renderPage();

    fireEvent.change(screen.getByRole("textbox", { name: "Recipe link" }), {
      target: { value: "https://a.com/one\nb.com/two\nhttps://c.com/three" }
    });
    // Offline, the button says what will happen.
    fireEvent.click(screen.getByRole("button", { name: "Queue 3 recipes for later" }));

    await waitFor(() =>
      expect(fakeIdb.records<ImportQueueItem>(IMPORT_QUEUE_STORE_NAME)).toHaveLength(3)
    );
    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Import queue" })).toBeVisible();
  });
});
