import { extractRecipeTextRequestSchema } from "@linkdish/api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  enqueueImport,
  getImportQueue,
  recoverStaleImports,
  resetImportQueueStoreForTests,
  retryImport,
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
import { readWebBillingUsage } from "../billing/web-billing";
import { deleteSavedRecipe, generateDeterministicId } from "../library/saved-recipe-store";

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
    extractRecipeFromText:
      vi.fn<(request: { text: string; sourceUrl?: string }) => Promise<unknown>>(),
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

/** Storage that opened but can't read one store any more (`method` rejects for it). */
const failReads = async (storeName: string, method: "getAll" | "getAllKeys") => {
  const db = (await getLinkDishWebDb()) as unknown as Record<
    typeof method,
    (name: string) => Promise<unknown>
  >;
  const read = db[method].bind(db);
  vi.spyOn(db, method).mockImplementation((name) =>
    name === storeName
      ? Promise.reject(new DOMException("The disk is unreadable.", "UnknownError"))
      : read(name)
  );
};

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

  describe("when the working tab's claim lapsed but no other tab took the item", () => {
    // Tab A was suspended mid-import (a frozen or backgrounded tab) past its lease, and another
    // page's mount put the item back in the queue without claiming it. A's result must still count.
    const heldExtraction = () => {
      let started: () => void = () => undefined;
      const extracting = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish: (response: unknown) => void = () => undefined;
      const hold = () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      };
      return { extracting, finish: (response: unknown) => finish(response), hold };
    };
    const freeTabA = () => context({ isAuthenticated: false, owner: "tab-a", tier: "free" });

    it("records a finished text import instead of importing it again", async () => {
      await enqueueImport({ text: "Soup: 1 onion, 2 cups stock. Simmer 20 minutes." });
      const extraction = heldExtraction();
      apiMocks.extractRecipeFromText
        .mockImplementationOnce(extraction.hold)
        .mockResolvedValue(success("Onion soup again", "https://linkdish.app/text-imports/b"));

      const tab = runImportQueue(freeTabA());
      await extraction.extracting;
      expect(await recoverStaleImports(Date.now() + STALE_PROCESSING_MS + 1000)).toBe(1);
      extraction.finish(success("Onion soup", "https://linkdish.app/text-imports/a"));

      await expect(tab).resolves.toEqual({ paused: null, processed: 1 });
      expect(apiMocks.extractRecipeFromText).toHaveBeenCalledOnce();
      expect(readWebBillingUsage()).toMatchObject({ imports: 1, strongExtractions: 1 });
      expect((await getImportQueue())[0]).toMatchObject({ status: "done" });
    });

    it("records a failed link instead of trying it again", async () => {
      await enqueueImport({ url: "https://blocked.com/r" });
      const extraction = heldExtraction();
      apiMocks.extractRecipe
        .mockImplementationOnce(extraction.hold)
        .mockResolvedValue(success("Blocked again", "https://blocked.com/r"));

      const tab = runImportQueue(freeTabA());
      await extraction.extracting;
      expect(await recoverStaleImports(Date.now() + STALE_PROCESSING_MS + 1000)).toBe(1);
      extraction.finish({ reason: "source_blocked", status: "failure", userMessage: "x" });

      await expect(tab).resolves.toEqual({ paused: null, processed: 1 });
      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect((await getImportQueue())[0]).toMatchObject({
        error: "That site kept its door shut",
        status: "failed"
      });
    });
  });

  it("lets a claimed link go, spending nothing, when another account signed in before it started", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    let checks = 0;

    await expect(
      runImportQueue(
        // Still the same account when the run picks the link, not by the time it would import it.
        context({ isCurrent: () => (checks += 1) === 1, isAuthenticated: false, tier: "free" })
      )
    ).resolves.toEqual({ paused: null, processed: 0 });

    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect(await statuses()).toEqual([["https://a.com/soup", "queued"]]);
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

  it("keeps the link waiting when another tab fills the last free slot mid-import", async () => {
    fakeIdb.seed(
      SAVED_RECIPES_STORE_NAME,
      Array.from({ length: 14 }, (_, index) => saved(`r${index}`, `https://x.com/${index}`))
    );
    await enqueueImport({ url: "https://a.com/soup" });
    apiMocks.extractRecipe.mockImplementation(() => {
      // The room check passed; another tab saves the 15th recipe before this one is kept.
      fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [saved("r14", "https://x.com/14")]);
      return Promise.resolve(success("Soup", "https://a.com/soup"));
    });

    await expect(runImportQueue(context({ owner: "tab-a", tier: "free" }))).resolves.toEqual({
      paused: "save_limit",
      processed: 0
    });

    const [item] = await getImportQueue();
    // Paused, not failed: making room and resuming picks it up again.
    expect(item?.status).toBe("queued");
    expect(item).not.toHaveProperty("claimedBy");
  });

  describe("when another tab takes the last free slot while the final import runs", () => {
    // The room check passed and the import was paid for (the API counted it, or the signed-out
    // allowance was spent), then another tab saved the 15th recipe before this one was kept.
    const cookbookOf = (count: number) =>
      Array.from({ length: count }, (_, index) => saved(`r${index}`, `https://x.com/${index}`));
    const takeLastSlotFirst = (response: unknown) => () => {
      fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [saved("r14", "https://x.com/14")]);
      return Promise.resolve(response);
    };
    const usedFreeImports = (imports: number) =>
      localStorage.setItem(
        "linkdish:web:billing-usage:v2",
        JSON.stringify({ imports, monthKey: "2026-09", strongExtractions: 0 })
      );
    const planLimit = {
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
    };
    const signedOut = () => context({ isAuthenticated: false, owner: "tab-a", tier: "free" });
    const signedIn = () => context({ owner: "tab-a", tier: "free" });
    const savedTitles = () =>
      fakeIdb
        .records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME)
        .map((recipe) => recipe.recipe.title)
        .filter((title) => !title.startsWith("Recipe r"));

    beforeEach(() => {
      fakeIdb.seed(SAVED_RECIPES_STORE_NAME, cookbookOf(14));
    });

    it("keeps the imported recipe with the link while it waits for room", async () => {
      await enqueueImport({ url: "https://a.com/soup" });
      apiMocks.extractRecipe.mockImplementation(
        takeLastSlotFirst(success("Soup", "https://a.com/soup"))
      );

      await expect(runImportQueue(signedIn())).resolves.toEqual({
        paused: "save_limit",
        processed: 0
      });

      const [item] = await getImportQueue();
      expect(item).toMatchObject({
        pendingSave: {
          correlationId: apiMocks.extractRecipe.mock.calls[0]?.[0].correlationId,
          extraction: { fetchMode: "http", strategy: "recipe-schema" },
          recipe: { title: "Soup" },
          sourceUrl: "https://a.com/soup"
        },
        status: "queued"
      });
      expect(item).not.toHaveProperty("claimedBy");
      expect(v2Events("recipe_saved")).toHaveLength(0);
    });

    it("saves it once there's room without spending the last free import again (signed out)", async () => {
      usedFreeImports(2);
      await enqueueImport({ url: "https://a.com/soup" });
      apiMocks.extractRecipe
        .mockImplementationOnce(takeLastSlotFirst(success("Soup", "https://a.com/soup")))
        .mockResolvedValue(success("Soup again", "https://a.com/soup"));

      await expect(runImportQueue(signedOut())).resolves.toEqual({
        paused: "save_limit",
        processed: 0
      });
      expect(readWebBillingUsage()).toMatchObject({ imports: 3 });

      // The cook makes room, and the queue carries on.
      await deleteSavedRecipe("r0");
      await expect(runImportQueue(signedOut())).resolves.toEqual({ paused: null, processed: 1 });

      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect(readWebBillingUsage()).toMatchObject({ imports: 3 });
      const [item] = await getImportQueue();
      expect(item).toMatchObject({ status: "done" });
      expect(item).not.toHaveProperty("pendingSave");
      expect(
        fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, item?.recipeId ?? "")?.recipe.title
      ).toBe("Soup");
      expect(v2Events("import_succeeded")).toHaveLength(1);
      expect(v2Events("recipe_saved")).toHaveLength(1);
    });

    it("saves it once there's room without importing it again (signed in)", async () => {
      await enqueueImport({ url: "https://a.com/soup" });
      // The API counted the import: asking again would be refused (or charged twice).
      apiMocks.extractRecipe
        .mockImplementationOnce(takeLastSlotFirst(success("Soup", "https://a.com/soup")))
        .mockResolvedValue(planLimit);

      await expect(runImportQueue(signedIn())).resolves.toEqual({
        paused: "save_limit",
        processed: 0
      });
      await deleteSavedRecipe("r0");
      await expect(runImportQueue(signedIn())).resolves.toEqual({ paused: null, processed: 1 });

      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect(savedTitles()).toEqual(["Soup"]);
      expect((await getImportQueue())[0]).toMatchObject({ status: "done" });
      expect(v2Events("import_succeeded")).toHaveLength(1);
      // Reported under the import it came from.
      expect(v2Events("recipe_saved").map(([event]) => event.correlationId)).toEqual([
        v2Events("import_succeeded")[0]?.[0].correlationId
      ]);
    });

    it("pauses again, spending nothing, while the cookbook is still full", async () => {
      usedFreeImports(2);
      await enqueueImport({ url: "https://a.com/soup" });
      apiMocks.extractRecipe
        .mockImplementationOnce(takeLastSlotFirst(success("Soup", "https://a.com/soup")))
        .mockResolvedValue(success("Soup again", "https://a.com/soup"));
      await runImportQueue(signedOut());

      // Out of imports too, but this one is paid for: only room is missing.
      await expect(runImportQueue(signedOut())).resolves.toEqual({
        paused: "save_limit",
        processed: 0
      });

      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect(readWebBillingUsage()).toMatchObject({ imports: 3 });
      expect((await getImportQueue())[0]).toMatchObject({
        pendingSave: { recipe: { title: "Soup" } },
        status: "queued"
      });
      expect(v2Events("recipe_saved")).toHaveLength(0);
    });

    it("saves a waiting recipe before a link that would need another import", async () => {
      usedFreeImports(2);
      await enqueueImport({ url: "https://a.com/soup" });
      apiMocks.extractRecipe
        .mockImplementationOnce(takeLastSlotFirst(success("Soup", "https://a.com/soup")))
        .mockResolvedValue(success("Stew", "https://b.com/stew"));
      await runImportQueue(signedOut());
      // An older link that had failed is tried again: it would need an import there's none of.
      fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [
        {
          attempts: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "older",
          status: "queued",
          updatedAt: "2026-01-01T00:00:00.000Z",
          url: "https://b.com/stew"
        }
      ]);
      // Room for both: only the import allowance holds the older link back.
      await deleteSavedRecipe("r0");
      await deleteSavedRecipe("r1");

      await expect(runImportQueue(signedOut())).resolves.toEqual({
        paused: "import_limit",
        processed: 1
      });

      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect(savedTitles()).toEqual(["Soup"]);
      expect(await statuses()).toEqual([
        ["https://b.com/stew", "queued"],
        ["https://a.com/soup", "done"]
      ]);
    });

    it("finishes with the recipe another tab saved from the same link meanwhile", async () => {
      await enqueueImport({ url: "https://a.com/soup" });
      apiMocks.extractRecipe.mockImplementationOnce(
        takeLastSlotFirst(success("Soup", "https://a.com/soup"))
      );
      await runImportQueue(signedIn());
      await deleteSavedRecipe("r0");
      fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [saved("theirs", "https://www.a.com/soup/")]);
      resetLibraryStoreForTests();

      await expect(runImportQueue(signedIn())).resolves.toEqual({ paused: null, processed: 1 });

      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect((await getImportQueue())[0]).toMatchObject({ recipeId: "theirs", status: "done" });
      expect((await getImportQueue())[0]).not.toHaveProperty("pendingSave");
      expect(savedTitles()).toEqual(["Recipe theirs"]);
      expect(v2Events("recipe_saved")).toHaveLength(0);
    });
  });

  it("keeps a recipe it imported but couldn't save, so Retry only saves it", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    apiMocks.extractRecipe
      .mockImplementationOnce(() => {
        fakeIdb.failNextPut(
          SAVED_RECIPES_STORE_NAME,
          new DOMException("The disk is full.", "QuotaExceededError")
        );
        return Promise.resolve(success("Soup", "https://a.com/soup"));
      })
      .mockResolvedValue(success("Soup again", "https://a.com/soup"));

    await runImportQueue(context({ isAuthenticated: false, owner: "tab-a", tier: "free" }));
    const [failed] = await getImportQueue();
    expect(failed).toMatchObject({ pendingSave: { recipe: { title: "Soup" } }, status: "failed" });
    expect(readWebBillingUsage()).toMatchObject({ imports: 1 });

    await retryImport(failed?.id ?? "");
    await expect(
      runImportQueue(context({ isAuthenticated: false, owner: "tab-a", tier: "free" }))
    ).resolves.toEqual({ paused: null, processed: 1 });

    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect(readWebBillingUsage()).toMatchObject({ imports: 1 });
    expect((await getImportQueue())[0]).toMatchObject({ status: "done" });
    expect(v2Events("import_succeeded")).toHaveLength(1);
    expect(v2Events("recipe_saved")).toHaveLength(1);
  });

  it("keeps the imported recipe when the connection drops before it's saved", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    apiMocks.extractRecipe
      .mockImplementationOnce(() => {
        networkMocks.online = false;
        fakeIdb.failNextPut(SAVED_RECIPES_STORE_NAME, new DOMException("Busy.", "UnknownError"));
        return Promise.resolve(success("Soup", "https://a.com/soup"));
      })
      .mockResolvedValue(success("Soup again", "https://a.com/soup"));

    await expect(runImportQueue(context({ owner: "tab-a" }))).resolves.toEqual({
      paused: "offline",
      processed: 0
    });
    expect((await getImportQueue())[0]).toMatchObject({
      pendingSave: { recipe: { title: "Soup" } },
      status: "queued"
    });

    networkMocks.online = true;
    await expect(runImportQueue(context({ owner: "tab-a" }))).resolves.toEqual({
      paused: null,
      processed: 1
    });
    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect((await getImportQueue())[0]).toMatchObject({ status: "done" });
  });

  it("lets a recipe waiting to be saved go with the item when the cookbook can't be read", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    apiMocks.extractRecipe.mockImplementationOnce(() => {
      fakeIdb.failNextPut(SAVED_RECIPES_STORE_NAME, new DOMException("Busy.", "UnknownError"));
      return Promise.resolve(success("Soup", "https://a.com/soup"));
    });
    await runImportQueue(context({ owner: "tab-a" }));
    await retryImport((await getImportQueue())[0]?.id ?? "");
    resetLibraryStoreForTests();
    await failReads(SAVED_RECIPES_STORE_NAME, "getAll");

    await expect(runImportQueue(context({ owner: "tab-a" }))).rejects.toThrow(
      "The disk is unreadable."
    );

    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    const [item] = await getImportQueue();
    expect(item).toMatchObject({ pendingSave: { recipe: { title: "Soup" } }, status: "queued" });
    expect(item).not.toHaveProperty("claimedBy");
  });

  it("lets the link go without spending an import when the cookbook can't be read", async () => {
    await enqueueImport({ url: "https://a.com/soup" });
    await enqueueImport({ url: "https://b.com/stew" });
    await failReads(SAVED_RECIPES_STORE_NAME, "getAllKeys");
    apiMocks.extractRecipe.mockResolvedValue(success("Soup", "https://a.com/soup"));

    // Not a full cookbook: storage trouble. Nothing is imported and the run stops.
    await expect(
      runImportQueue(context({ isAuthenticated: false, owner: "tab-a", tier: "free" }))
    ).rejects.toThrow("The disk is unreadable.");

    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect(readWebBillingUsage()).toMatchObject({ imports: 0 });
    const queue = await getImportQueue();
    expect(queue.map((item) => [item.url, item.status, item.attempts])).toEqual([
      ["https://a.com/soup", "queued", 0],
      ["https://b.com/stew", "queued", 0]
    ]);
    // Back in the queue for any tab, not held by this one.
    expect(queue[0]).not.toHaveProperty("claimedBy");
    expect(v2Events("import_failed")).toHaveLength(0);
  });

  it("doesn't import a link it couldn't check against the cookbook", async () => {
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [saved("existing", "https://www.a.com/soup")]);
    await enqueueImport({ url: "https://a.com/soup" });
    await failReads(SAVED_RECIPES_STORE_NAME, "getAll");
    apiMocks.extractRecipe.mockResolvedValue(success("Soup", "https://a.com/soup"));

    // A paid plan never counts the cookbook, so only the duplicate check reads it.
    await expect(runImportQueue(context({ owner: "tab-a" }))).rejects.toThrow(
      "The disk is unreadable."
    );

    expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
    expect((await getImportQueue())[0]).toMatchObject({ attempts: 0, status: "queued" });
    expect((await getImportQueue())[0]).not.toHaveProperty("claimedBy");
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

  it("doesn't use AI help by itself for an account that signed in since", async () => {
    await enqueueImport({ url: "https://www.tiktok.com/@cook/video/1" });
    let sameAccount = true;
    apiMocks.extractRecipe.mockImplementationOnce(() => {
      sameAccount = false;
      return Promise.resolve({
        diagnostics: { confidenceScore: 0.3, missingFields: ["ingredients"] },
        reason: "unsupported_primary_extraction",
        sourceType: "social",
        status: "needs_retry",
        suggestedAttempt: "fallback",
        userMessage: "Needs help"
      });
    });

    await expect(
      runImportQueue(
        context({ isCurrent: () => sameAccount, isAuthenticated: false, tier: "free" })
      )
    ).resolves.toEqual({ paused: null, processed: 0 });

    // The link waits for a run of the account signed in now, and no signed-out AI help is spent.
    expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
    expect(await statuses()).toEqual([["https://www.tiktok.com/@cook/video/1", "queued"]]);
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

  describe("queued text with the link it came from", () => {
    const link = "https://example.com/noodles";
    const caption = `Sesame noodles, from ${link}\n200 g noodles\nToss and serve.`;
    /** The API names the recipe's source after the link it's sent, or makes one up without it. */
    const fromTheLinkGiven =
      (title: string) =>
      (request: { sourceUrl?: string }): Promise<unknown> =>
        Promise.resolve(
          success(title, request.sourceUrl ?? "https://linkdish.app/text-imports/abc")
        );
    const savedFrom = (sourceUrl: string) =>
      fakeIdb
        .records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME)
        .filter((recipe) => recipe.sourceUrl === sourceUrl);

    it("sends the link with the text and keeps it as the recipe's source, as the importer does", async () => {
      await enqueueImport({ sourceUrl: link, text: caption });
      apiMocks.extractRecipeFromText.mockResolvedValue(
        success("Sesame noodles", "https://linkdish.app/text-imports/abc")
      );

      await expect(runImportQueue(context())).resolves.toEqual({ paused: null, processed: 1 });

      expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
      expect(apiMocks.extractRecipeFromText.mock.calls[0]?.[0]).toMatchObject({
        attempt: "fallback",
        sourceUrl: link,
        text: caption
      });
      const [kept] = savedFrom(link);
      expect(kept).toMatchObject({
        recipe: { title: "Sesame noodles" },
        sourceHost: "example.com"
      });
      expect(kept?.id).toBe(await generateDeterministicId(link, "Sesame noodles"));
      expect((await getImportQueue())[0]).toMatchObject({ recipeId: kept?.id, status: "done" });
      expect(v2Events("import_succeeded")[0]?.[0].properties).toMatchObject({
        attempt: "fallback",
        source_type: "text"
      });
    });

    it("lets a later import of that page find the recipe without spending one", async () => {
      await enqueueImport({ sourceUrl: link, text: caption });
      apiMocks.extractRecipeFromText.mockImplementation(fromTheLinkGiven("Sesame noodles"));
      await runImportQueue(context());
      const [kept] = savedFrom(link);

      await enqueueImport({ url: "https://www.example.com/noodles/?utm_source=ig" });
      await runImportQueue(context());

      expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
      expect((await getImportQueue()).map((item) => item.recipeId)).toEqual([kept?.id, kept?.id]);
    });

    it("finishes with the same recipe from that page when it's saved already", async () => {
      const id = await generateDeterministicId(link, "Sesame noodles");
      fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
        { ...saved(id, link), recipe: recipeFor("Sesame noodles", link) }
      ]);
      await enqueueImport({ sourceUrl: link, text: caption });
      apiMocks.extractRecipeFromText.mockImplementation(fromTheLinkGiven("Sesame noodles"));

      await expect(runImportQueue(context())).resolves.toEqual({ paused: null, processed: 1 });

      expect((await getImportQueue())[0]).toMatchObject({ recipeId: id, status: "done" });
      expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toHaveLength(1);
      expect(v2Events("recipe_saved")).toHaveLength(0);
    });

    it("imports two different texts from the same link as two recipes", async () => {
      await enqueueImport({ sourceUrl: link, text: caption });
      await enqueueImport({ sourceUrl: link, text: `Chili oil noodles, from ${link}\n...` });
      apiMocks.extractRecipeFromText
        .mockImplementationOnce(fromTheLinkGiven("Sesame noodles"))
        .mockImplementationOnce(fromTheLinkGiven("Chili oil noodles"));

      await expect(runImportQueue(context())).resolves.toEqual({ paused: null, processed: 2 });

      expect(apiMocks.extractRecipeFromText).toHaveBeenCalledTimes(2);
      expect(
        savedFrom(link)
          .map((recipe) => recipe.recipe.title)
          .sort()
      ).toEqual(["Chili oil noodles", "Sesame noodles"]);
    });

    it("keeps the link with a recipe that waits for room, and saves it from there", async () => {
      fakeIdb.seed(
        SAVED_RECIPES_STORE_NAME,
        Array.from({ length: 14 }, (_, index) => saved(`r${index}`, `https://x.com/${index}`))
      );
      await enqueueImport({ sourceUrl: link, text: caption });
      apiMocks.extractRecipeFromText.mockImplementationOnce(() => {
        // Another tab takes the last free slot while this import runs.
        fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [saved("r14", "https://x.com/14")]);
        return Promise.resolve(success("Sesame noodles", "https://linkdish.app/text-imports/abc"));
      });
      const signedIn = context({ owner: "tab-a", tier: "free" });

      await expect(runImportQueue(signedIn)).resolves.toEqual({
        paused: "save_limit",
        processed: 0
      });
      expect((await getImportQueue())[0]).toMatchObject({
        pendingSave: { sourceUrl: link },
        sourceUrl: link,
        status: "queued"
      });

      await deleteSavedRecipe("r0");
      await expect(runImportQueue(signedIn)).resolves.toEqual({ paused: null, processed: 1 });

      expect(apiMocks.extractRecipeFromText).toHaveBeenCalledOnce();
      expect(savedFrom(link).map((recipe) => recipe.recipe.title)).toEqual(["Sesame noodles"]);
    });

    it("imports the text without a link the API wouldn't take (a sign-in in it, or too long)", async () => {
      const madeUp = "https://linkdish.app/text-imports/abc";
      // Like the real client: the request is checked against the API contract before it's sent.
      apiMocks.extractRecipeFromText.mockImplementation((request) => {
        const parsed = extractRecipeTextRequestSchema.safeParse(request);

        return parsed.success
          ? Promise.resolve(success("Sesame noodles", parsed.data.sourceUrl ?? madeUp))
          : Promise.reject(
              new apiMocks.ExtractorApiError("Input is invalid.", 0, parsed.error, "validation")
            );
      });

      for (const badLink of [
        "https://cook:secret@example.com/noodles",
        `https://example.com/noodles?${"x".repeat(2_100)}`
      ]) {
        await enqueueImport({ sourceUrl: badLink, text: `Sesame noodles, from ${badLink}\n...` });
      }

      await expect(runImportQueue(context())).resolves.toEqual({ paused: null, processed: 2 });

      expect((await getImportQueue()).map((item) => item.status)).toEqual(["done", "done"]);
      for (const [request] of apiMocks.extractRecipeFromText.mock.calls) {
        expect(request).not.toHaveProperty("sourceUrl");
      }
      expect(savedFrom(madeUp)).toHaveLength(1);
    });

    /** The recipe the API reads from a paste: the text's lines after the first are its ingredients. */
    const readFromThePaste =
      (title: string) =>
      (request: { text: string; sourceUrl?: string }): Promise<unknown> => {
        const response = success(
          title,
          request.sourceUrl ?? "https://linkdish.app/text-imports/abc"
        );
        response.recipe.ingredients = request.text
          .split("\n")
          .slice(1)
          .map((line) => ({ text: line }));
        return Promise.resolve(response);
      };
    const cutOff = `Sesame noodles ${link}\n200 g noodles`;
    const corrected = `Sesame noodles ${link}\n200 g noodles\n1 tbsp chili oil`;
    /** Each saved recipe's title and ingredients, by title. */
    const ingredientsFrom = (sourceUrl: string) =>
      savedFrom(sourceUrl)
        .sort((left, right) => left.recipe.title.localeCompare(right.recipe.title))
        .map((recipe) => [recipe.recipe.title, recipe.recipe.ingredients.map(({ text }) => text)]);

    it("keeps a corrected paste of the same caption as a copy instead of dropping it", async () => {
      await enqueueImport({ sourceUrl: link, text: cutOff });
      await enqueueImport({ sourceUrl: link, text: corrected });
      // The same paste again: its recipe is the corrected one, which is saved by now.
      await enqueueImport({ sourceUrl: link, text: corrected });
      apiMocks.extractRecipeFromText.mockImplementation(readFromThePaste("Sesame noodles"));

      await expect(runImportQueue(context())).resolves.toEqual({ paused: null, processed: 3 });

      expect(apiMocks.extractRecipeFromText).toHaveBeenCalledTimes(3);
      expect(ingredientsFrom(link)).toEqual([
        ["Sesame noodles", ["200 g noodles"]],
        ["Sesame noodles (copy)", ["200 g noodles", "1 tbsp chili oil"]]
      ]);
      const copyId = await generateDeterministicId(link, "Sesame noodles (copy)");
      expect((await getImportQueue()).map((item) => item.recipeId)).toEqual([
        await generateDeterministicId(link, "Sesame noodles"),
        copyId,
        copyId
      ]);
    });

    it("keeps a corrected paste that waits for room as a copy once there is room", async () => {
      fakeIdb.seed(
        SAVED_RECIPES_STORE_NAME,
        Array.from({ length: 13 }, (_, index) => saved(`r${index}`, `https://x.com/${index}`))
      );
      await enqueueImport({ sourceUrl: link, text: cutOff });
      await enqueueImport({ sourceUrl: link, text: corrected });
      apiMocks.extractRecipeFromText
        .mockImplementationOnce(readFromThePaste("Sesame noodles"))
        .mockImplementationOnce(async (request) => {
          // Another tab takes the last free slot while the corrected paste is imported.
          fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [saved("r14", "https://x.com/14")]);
          return readFromThePaste("Sesame noodles")(request);
        });
      const signedIn = context({ owner: "tab-a", tier: "free" });

      await expect(runImportQueue(signedIn)).resolves.toEqual({
        paused: "save_limit",
        processed: 1
      });
      await deleteSavedRecipe("r0");
      await expect(runImportQueue(signedIn)).resolves.toEqual({ paused: null, processed: 1 });

      expect(apiMocks.extractRecipeFromText).toHaveBeenCalledTimes(2);
      expect(ingredientsFrom(link)).toEqual([
        ["Sesame noodles", ["200 g noodles"]],
        ["Sesame noodles (copy)", ["200 g noodles", "1 tbsp chili oil"]]
      ]);
    });
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

  describe("when someone else signs in (or out) while it runs", () => {
    /** The account the run started for, until `switchAccount` (someone else signs in or out). */
    const account = () => {
      let current = true;
      return { isCurrent: () => current, switchAccount: () => (current = false) };
    };

    it("doesn't start an import once the account has changed", async () => {
      await enqueueImport({ url: "https://a.com/soup" });
      const { isCurrent, switchAccount } = account();
      switchAccount();

      await expect(runImportQueue(context({ isCurrent }))).resolves.toEqual({
        paused: null,
        processed: 0
      });
      expect(apiMocks.extractRecipe).not.toHaveBeenCalled();
      expect(await statuses()).toEqual([["https://a.com/soup", "queued"]]);
    });

    it("doesn't charge the signed-out allowance for an import that finishes after signing in", async () => {
      await enqueueImport({ url: "https://a.com/soup" });
      await enqueueImport({ url: "https://b.com/stew" });
      const { isCurrent, switchAccount } = account();
      apiMocks.extractRecipe.mockImplementation(() => {
        switchAccount();
        return Promise.resolve(success("Soup", "https://a.com/soup"));
      });

      await expect(
        runImportQueue(context({ isAuthenticated: false, isCurrent, tier: "free" }))
      ).resolves.toEqual({ paused: null, processed: 0 });

      expect(readWebBillingUsage()).toMatchObject({ imports: 0 });
      // The run stops: the next link waits for a run as the account now signed in.
      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      const [soup, stew] = await getImportQueue();
      // Paid for: the recipe waits with its link, for that run to save without importing it again.
      expect(soup).toMatchObject({
        pendingSave: { sourceUrl: "https://a.com/soup" },
        status: "queued"
      });
      expect(stew?.status).toBe("queued");

      await runImportQueue(context({ isAuthenticated: true, tier: "plus" }));

      expect(apiMocks.extractRecipe).toHaveBeenCalledTimes(2);
      expect(await statuses()).toEqual([
        ["https://a.com/soup", "done"],
        ["https://b.com/stew", "done"]
      ]);
    });

    it("never shares a recipe into the household as an account that has signed out", async () => {
      await enqueueImport({ url: "https://a.com/soup" });
      apiMocks.getHousehold.mockResolvedValue({ household: { id: "household-1" } });
      apiMocks.createSharedRecipe.mockResolvedValue({
        recipe: { id: "shared-1", updatedAt: "2026-09-01T00:00:00.000Z" }
      });
      const { isCurrent, switchAccount } = account();
      apiMocks.extractRecipe.mockImplementation(() => {
        switchAccount();
        return Promise.resolve(success("Soup", "https://a.com/soup"));
      });

      await runImportQueue(context({ isAuthenticated: true, isCurrent }));
      // The next run, signed out, saves it on this device only.
      await runImportQueue(context({ isAuthenticated: false, tier: "free" }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(await statuses()).toEqual([["https://a.com/soup", "done"]]);
      expect(apiMocks.getHousehold).not.toHaveBeenCalled();
      expect(apiMocks.createSharedRecipe).not.toHaveBeenCalled();
    });

    it("leaves AI help to the account now signed in", async () => {
      await enqueueImport({ url: "https://www.instagram.com/p/abc" });
      const { isCurrent, switchAccount } = account();
      apiMocks.extractRecipe.mockImplementation(() => {
        switchAccount();
        return Promise.resolve({ reason: "needs_ai", status: "needs_retry" });
      });

      await runImportQueue(context({ isAuthenticated: false, isCurrent, tier: "free" }));

      expect(apiMocks.extractRecipe).toHaveBeenCalledOnce();
      expect(readWebBillingUsage()).toMatchObject({ imports: 0, strongExtractions: 0 });
      expect(await statuses()).toEqual([["https://www.instagram.com/p/abc", "queued"]]);
      expect(v2Events("import_abandoned")).toHaveLength(1);
    });
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
