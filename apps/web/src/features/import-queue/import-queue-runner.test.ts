import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  enqueueImport,
  getImportQueue,
  resetImportQueueStoreForTests,
  STALE_PROCESSING_MS
} from "../../data/import-queue-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import {
  getLinkDishWebDb,
  IMPORT_QUEUE_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { runImportQueue } from "./import-queue-runner";

import type { QueueRunnerContext } from "./import-queue-runner";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeRequest } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const apiMocks = vi.hoisted(() => {
  class ExtractorApiError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown,
      public readonly kind = "http"
    ) {
      super(message);
      this.name = "ExtractorApiError";
    }
  }

  return {
    ExtractorApiError,
    createSharedRecipe: vi.fn(),
    extractRecipe: vi.fn<(request: ExtractRecipeRequest) => Promise<unknown>>(),
    extractRecipeFromText: vi.fn<(request: { text: string }) => Promise<unknown>>(),
    getHousehold: vi.fn()
  };
});

vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: {
    createSharedRecipe: apiMocks.createSharedRecipe,
    extractRecipe: apiMocks.extractRecipe,
    extractRecipeFromText: apiMocks.extractRecipeFromText,
    getHousehold: apiMocks.getHousehold
  },
  ExtractorApiError: apiMocks.ExtractorApiError,
  isExtractorApiError: (error: unknown) => error instanceof apiMocks.ExtractorApiError
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: vi.fn(),
  trackWebV2AnalyticsEvent: vi.fn()
}));

const networkMocks = vi.hoisted(() => ({ online: true }));

vi.mock("../../platform/detect-network", () => ({
  addNetworkListeners: () => () => undefined,
  isOnline: () => networkMocks.online
}));

const recipeFor = (title: string, sourceUrl: string): Recipe => ({
  confidence: {
    fieldProvenance: {
      cookTimeMinutes: null,
      ingredients: "jsonld",
      nutrition: null,
      prepTimeMinutes: null,
      servings: null,
      steps: "jsonld",
      title: "jsonld"
    },
    missingFields: [],
    notes: [],
    score: 0.95,
    summary: "High confidence"
  },
  cookTimeMinutes: null,
  ingredients: [{ text: "1 cup rice" }],
  nutrition: null,
  prepTimeMinutes: null,
  servings: "2",
  sourceType: "recipe-webpage",
  sourceUrl,
  steps: [{ index: 1, text: "Cook." }],
  title
});

const success = (title: string, sourceUrl: string) => ({
  extraction: {
    confidenceScore: 0.95,
    fetchMode: "http",
    missingFields: [],
    provenance: ["jsonld"],
    sourceType: "recipe-webpage",
    strategy: "recipe-schema",
    warnings: []
  },
  recipe: recipeFor(title, sourceUrl),
  status: "success"
});

const saved = (id: string, sourceUrl: string): WebSavedRecipe => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  id,
  recipe: recipeFor(`Recipe ${id}`, sourceUrl),
  sourceHost: "example.com",
  sourceUrl,
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-09-01T00:00:00.000Z"
});

const context = (overrides: Partial<QueueRunnerContext> = {}): QueueRunnerContext => ({
  isAuthenticated: true,
  signal: new AbortController().signal,
  tier: "plus",
  ...overrides
});

const statuses = async () =>
  (await getImportQueue()).map((item) => [item.url ?? item.text, item.status]);

const v2Events = (name: string) =>
  vi.mocked(trackWebV2AnalyticsEvent).mock.calls.filter(([event]) => event.name === name);

describe("import queue runner", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    localStorage.clear();
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
    networkMocks.online = true;
    vi.mocked(trackWebEvent).mockClear();
    vi.mocked(trackWebV2AnalyticsEvent).mockClear();
    apiMocks.extractRecipe.mockReset();
    apiMocks.extractRecipeFromText.mockReset();
    apiMocks.getHousehold.mockReset();
    apiMocks.getHousehold.mockResolvedValue({ household: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports queued links one at a time and saves each success", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    await enqueueImport({ url: "https://b.com/stew" });
    let inFlight = 0;
    apiMocks.extractRecipe.mockImplementation(async (request) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      inFlight -= 1;
      return success(
        `From ${new URL((request as { url: string }).url).host}`,
        (request as { url: string }).url
      );
    });

    await expect(runImportQueue(context())).resolves.toEqual({ paused: null, processed: 2 });

    expect(
      apiMocks.extractRecipe.mock.calls.map(([request]) => (request as { url: string }).url)
    ).toEqual(["https://a.com/soup", "https://b.com/stew"]);
    expect(await statuses()).toEqual([
      ["https://a.com/soup", "done"],
      ["https://b.com/stew", "done"]
    ]);
    const savedTitles = fakeIdb
      .records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME)
      .map((recipe) => recipe.recipe.title)
      .sort();
    expect(savedTitles).toEqual(["From a.com", "From b.com"]);
    expect((await getImportQueue()).every((item) => item.recipeId)).toBe(true);
    expect(
      vi.mocked(trackWebEvent).mock.calls.filter(([event]) => event.eventName === "import_started")
    ).toHaveLength(2);
    expect(v2Events("import_succeeded")).toHaveLength(2);
  });

  it("imports each queued link exactly once when two tabs run the queue at the same time", async () => {
    // No navigator.locks (older Safari, insecure origins): every open import page runs a worker.
    await enqueueImport({ url: "https://a.com/soup" });
    await enqueueImport({ url: "https://b.com/stew" });
    await enqueueImport({ url: "https://c.com/pie" });
    apiMocks.extractRecipe.mockImplementation(async (request) => {
      const url = (request as { url: string }).url;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return success(`From ${new URL(url).host}`, url);
    });

    const [first, second] = await Promise.all([
      runImportQueue(context({ owner: "tab-a" })),
      runImportQueue(context({ owner: "tab-b" }))
    ]);

    const extracted = apiMocks.extractRecipe.mock.calls
      .map(([request]) => (request as { url: string }).url)
      .sort();
    expect(extracted).toEqual(["https://a.com/soup", "https://b.com/stew", "https://c.com/pie"]);
    expect(first.processed + second.processed).toBe(3);
    expect(await statuses()).toEqual([
      ["https://a.com/soup", "done"],
      ["https://b.com/stew", "done"],
      ["https://c.com/pie", "done"]
    ]);
    expect(v2Events("import_succeeded")).toHaveLength(3);
  });

  it("never takes over an import another tab is still working on, however long it takes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });

    try {
      await enqueueImport({ url: "https://slow.com/stew" });
      let started: () => void = () => undefined;
      const extracting = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish: (response: unknown) => void = () => undefined;
      apiMocks.extractRecipe
        .mockImplementationOnce(() => {
          started();
          return new Promise((resolve) => {
            finish = resolve;
          });
        })
        .mockResolvedValue(success("Stew again", "https://slow.com/stew"));

      const slowTab = runImportQueue(context({ owner: "tab-a" }));
      await extracting;
      // Well past the lease: only tab-a's renewals show it is still at work.
      await vi.advanceTimersByTimeAsync(2 * STALE_PROCESSING_MS);

      await expect(runImportQueue(context({ owner: "tab-b" }))).resolves.toEqual({
        paused: null,
        processed: 0
      });
      expect((await getImportQueue())[0]).toMatchObject({
        claimedBy: "tab-a",
        status: "processing"
      });

      finish(success("Stew", "https://slow.com/stew"));
      await expect(slowTab).resolves.toEqual({ paused: null, processed: 1 });
      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect((await getImportQueue())[0]?.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips links that are already in the cookbook without spending an import", async () => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [saved("existing", "https://www.a.com/soup")]);
    await enqueueImport({ url: "https://a.com/soup/?utm_source=x" });

    await runImportQueue(context());

    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect((await getImportQueue())[0]).toMatchObject({ recipeId: "existing", status: "done" });
  });

  it("leaves failures in the queue with a plain reason and carries on", async () => {
    await enqueueImport({ url: "https://blocked.com/r" });
    await enqueueImport({ url: "https://ok.com/r" });
    apiMocks.extractRecipe
      .mockResolvedValueOnce({ reason: "source_blocked", status: "failure", userMessage: "x" })
      .mockResolvedValueOnce(success("Fine", "https://ok.com/r"));

    await runImportQueue(context());

    const [blocked, ok] = await getImportQueue();
    expect(blocked).toMatchObject({ error: "That site kept its door shut", status: "failed" });
    expect(ok?.status).toBe("done");
    expect(v2Events("import_failed")).toHaveLength(1);
  });

  it("pauses at the plan limit and keeps the link waiting", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    await enqueueImport({ url: "https://b.com/stew" });
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
      userMessage: "Used up."
    });

    // The pause is all it reports: the panel shows it, and nothing pops up on its own.
    await expect(runImportQueue(context({ tier: "free" }))).resolves.toEqual({
      paused: "import_limit",
      processed: 0
    });

    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect(await statuses()).toEqual([
      ["https://a.com/soup", "queued"],
      ["https://b.com/stew", "queued"]
    ]);
  });

  it("does not mistake the AI provider's capacity for the plan limit", async () => {
    await enqueueImport({ url: "https://www.tiktok.com/@cook/video/1" });
    apiMocks.extractRecipe.mockResolvedValue({
      reason: "quota_exceeded",
      status: "failure",
      userMessage: "Extra recipe help is temporarily unavailable."
    });

    await expect(runImportQueue(context())).resolves.toEqual({
      paused: null,
      processed: 1
    });
    expect((await getImportQueue())[0]?.status).toBe("failed");
  });

  it("stops before spending an import when the free cookbook is full", async () => {
    fakeIdb.seed(
      SAVED_RECIPES_STORE_NAME,
      Array.from({ length: 15 }, (_, index) => saved(`r${index}`, `https://x.com/${index}`))
    );
    await enqueueImport({ url: "https://a.com/soup" });

    await expect(runImportQueue(context({ tier: "free" }))).resolves.toEqual({
      paused: "save_limit",
      processed: 0
    });
    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect((await getImportQueue())[0]?.status).toBe("queued");
  });

  it("puts a link back in the queue when the connection drops mid-import", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    apiMocks.extractRecipe.mockImplementation(() => {
      networkMocks.online = false;
      return Promise.reject(new apiMocks.ExtractorApiError("offline", 0, undefined, "network"));
    });

    await expect(runImportQueue(context())).resolves.toEqual({ paused: "offline", processed: 0 });
    expect((await getImportQueue())[0]).toMatchObject({ attempts: 1, status: "queued" });
  });

  it("uses AI help by itself for social posts, on one correlation id", async () => {
    await enqueueImport({ url: "https://www.tiktok.com/@cook/video/1" });
    apiMocks.extractRecipe
      .mockResolvedValueOnce({
        diagnostics: { confidenceScore: 0.3, missingFields: ["ingredients"] },
        reason: "unsupported_primary_extraction",
        sourceType: "social",
        status: "needs_retry",
        suggestedAttempt: "fallback",
        userMessage: "Needs help"
      })
      .mockResolvedValueOnce(success("Caption noodles", "https://www.tiktok.com/@cook/video/1"));

    await runImportQueue(context({ tier: "free" }));

    const [primary, fallback] = apiMocks.extractRecipe.mock.calls.map(([request]) => request);
    expect(fallback).toMatchObject({ attempt: "fallback", correlationId: primary?.correlationId });
    expect((await getImportQueue())[0]?.status).toBe("done");
  });

  it("asks for a hand when a free web page needs AI help", async () => {
    await enqueueImport({ url: "https://blog.com/stew" });
    apiMocks.extractRecipe.mockResolvedValue({
      diagnostics: { confidenceScore: 0.3, missingFields: ["ingredients"] },
      reason: "low_confidence",
      sourceType: "article",
      status: "needs_retry",
      suggestedAttempt: "fallback",
      userMessage: "Needs help"
    });

    await runImportQueue(context({ tier: "free" }));

    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect((await getImportQueue())[0]).toMatchObject({
      error: "This one needs AI help. Open it to try.",
      status: "failed"
    });
  });

  it("imports queued text through AI help", async () => {
    await enqueueImport({ text: "Soup: 1 onion, 2 cups stock. Simmer 20 minutes." });
    apiMocks.extractRecipeFromText.mockResolvedValue(
      success("Onion soup", "https://linkdish.app/text-imports/abc")
    );

    await runImportQueue(context());

    expect(apiMocks.extractRecipeFromText.mock.calls[0]?.[0]).toMatchObject({
      attempt: "fallback",
      text: "Soup: 1 onion, 2 cups stock. Simmer 20 minutes."
    });
    expect((await getImportQueue())[0]?.status).toBe("done");
  });

  it("recovers imports left 'processing' by a closed tab", async () => {
    const old = new Date(Date.now() - STALE_PROCESSING_MS - 60_000).toISOString();
    fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [
      {
        attempts: 1,
        createdAt: old,
        id: "stale",
        status: "processing",
        updatedAt: old,
        url: "https://a.com/soup"
      }
    ]);
    apiMocks.extractRecipe.mockResolvedValue(success("Soup", "https://a.com/soup"));

    await runImportQueue(context());

    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect((await getImportQueue())[0]).toMatchObject({ id: "stale", status: "done" });
  });

  it("stops quietly when the page goes away", async () => {
    const controller = new AbortController();
    await enqueueImport({ url: "https://a.com/soup" });
    apiMocks.extractRecipe.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });

    await expect(runImportQueue(context({ signal: controller.signal }))).resolves.toEqual({
      paused: null,
      processed: 0
    });
    expect((await getImportQueue())[0]?.status).toBe("queued");
    expect(v2Events("import_abandoned")).toHaveLength(1);
    expect(v2Events("import_failed")).toHaveLength(0);
  });
});
