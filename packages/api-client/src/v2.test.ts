import { describe, expect, it, vi } from "vitest";

import { createExtractorApiClient, ExtractorApiError, isExtractorApiError } from "./index.js";

type FetchSignature = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });

const createClient = (fetchImplementation: FetchSignature, timeoutMs?: number) =>
  createExtractorApiClient({
    baseUrl: "https://api.test",
    fetchImplementation: fetchImplementation as unknown as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("Expected the call to reject.");
    },
    (error: unknown) => error
  );

/* Rejects like fetch does once its signal aborts. */
const hangingFetch: FetchSignature = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;

    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }

    signal?.addEventListener("abort", () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    });
  });

const successEnvelope = {
  status: "success",
  recipe: {
    title: "Soup",
    sourceUrl: "https://example.com/soup",
    sourceType: "unknown",
    ingredients: [{ text: "1 onion" }],
    steps: [{ index: 1, text: "Cook." }],
    servings: null,
    prepTimeMinutes: null,
    cookTimeMinutes: null,
    nutrition: null,
    confidence: {
      score: 0.8,
      summary: "Fallback extraction produced a structured recipe candidate.",
      missingFields: [],
      notes: [],
      fieldProvenance: {
        title: "llm",
        ingredients: "llm",
        steps: "llm",
        servings: null,
        prepTimeMinutes: null,
        cookTimeMinutes: null,
        nutrition: null
      }
    }
  },
  extraction: {
    sourceType: "unknown",
    strategy: "llm-fallback",
    confidenceScore: 0.8,
    missingFields: [],
    warnings: [],
    fetchMode: "http",
    provenance: ["llm"]
  },
  quota: {
    limit: 3,
    remaining: 1,
    monthlyLimit: null,
    remainingThisMonth: null,
    resetsAt: null,
    meteringMode: "free_lifetime"
  }
} as const;

describe("input validation", () => {
  it("rejects instead of throwing synchronously and never calls fetch", async () => {
    const fetchImplementation = vi.fn<FetchSignature>();
    const client = createClient(fetchImplementation);
    let pending: Promise<unknown> | null = null;

    expect(() => {
      pending = client.extractRecipe({ url: "not-a-url", attempt: "primary" });
    }).not.toThrow();

    const error = await captureRejection(pending!);

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect((error as ExtractorApiError).kind).toBe("validation");
    expect((error as ExtractorApiError).statusCode).toBe(0);
    expect(Array.isArray((error as ExtractorApiError).details)).toBe(true);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("validates every method that takes input the same way", async () => {
    const fetchImplementation = vi.fn<FetchSignature>();
    const client = createClient(fetchImplementation);
    const calls: Array<() => Promise<unknown>> = [
      () => client.cancelHouseholdInvite({ inviteId: "" }),
      () => client.requestLoginCode({ email: "not-an-email" }),
      () => client.extractRecipeFromText({ text: "too short" }),
      () => client.sendAnalyticsEvents({ events: [] })
    ];

    for (const call of calls) {
      const error = await captureRejection(call());
      expect(isExtractorApiError(error) && error.kind).toBe("validation");
    }

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("surfaces a failing header provider as a rejection", async () => {
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: vi.fn<FetchSignature>() as unknown as typeof fetch,
      getHeaders: () => {
        throw new Error("no token");
      }
    });

    await expect(client.getSession()).rejects.toThrow("no token");
  });
});

describe("error kinds", () => {
  it("marks http errors and exposes the server message", async () => {
    const client = createClient(() =>
      Promise.resolve(jsonResponse({ message: "Sign in is required." }, 401))
    );

    const error = (await captureRejection(client.getHousehold())) as ExtractorApiError;

    expect(error.kind).toBe("http");
    expect(error.statusCode).toBe(401);
    expect(error.serverMessage).toBe("Sign in is required.");
    expect(error.message).toBe("Extractor API request failed.");
    expect(error.details).toEqual({ message: "Sign in is required." });
  });

  it("marks contract mismatches", async () => {
    const client = createClient(() => Promise.resolve(jsonResponse({ unexpected: true })));

    const error = (await captureRejection(client.getSession())) as ExtractorApiError;

    expect(error.kind).toBe("contract");
    expect(error.statusCode).toBe(200);
    expect(error.message).toBe("Extractor API response did not match the contract.");
    expect(error.serverMessage).toBeUndefined();
  });

  it("wraps network failures but keeps the original message", async () => {
    const cause = new TypeError("Network request failed");
    const client = createClient(() => Promise.reject(cause));

    const error = (await captureRejection(client.getSession())) as ExtractorApiError;

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect(error.kind).toBe("network");
    expect(error.statusCode).toBe(0);
    expect(error.message).toBe("Network request failed");
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("treats a body that fails mid-read as a network failure", async () => {
    const client = createClient(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.reject(new TypeError("terminated"))
      } as unknown as Response)
    );

    const error = (await captureRejection(client.getSession())) as ExtractorApiError;

    expect(error.kind).toBe("network");
  });

  it("wraps client timeouts", async () => {
    const client = createClient(hangingFetch, 15);

    const error = (await captureRejection(client.getSession())) as ExtractorApiError;

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect(error.kind).toBe("timeout");
    expect(error.statusCode).toBe(0);
  });

  it("keeps the legacy constructor working and defaults to http", () => {
    const error = new ExtractorApiError("Extractor API request failed.", 503, {
      message: "Busy"
    });

    expect(error.kind).toBe("http");
    expect(error.serverMessage).toBe("Busy");
    expect(error.name).toBe("ExtractorApiError");
  });
});

describe("caller abort signals", () => {
  it("rejects with the caller's reason, not an ExtractorApiError", async () => {
    const controller = new AbortController();
    const client = createClient(hangingFetch, 10_000);
    const pending = client.getSession({ signal: controller.signal });
    const reason = new Error("user left the page");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("does not call fetch when the signal is already aborted", async () => {
    const fetchImplementation = vi.fn<FetchSignature>();
    const controller = new AbortController();
    controller.abort();
    const client = createClient(fetchImplementation);

    const error = await captureRejection(
      client.extractRecipe(
        { url: "https://example.com/soup", attempt: "primary" },
        { signal: controller.signal }
      )
    );

    expect((error as Error).name).toBe("AbortError");
    expect(isExtractorApiError(error)).toBe(false);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("combines the caller signal with the timeout", async () => {
    const fetchImplementation = vi.fn<FetchSignature>(() =>
      Promise.resolve(jsonResponse({ authenticated: false }))
    );
    const controller = new AbortController();
    const client = createClient(fetchImplementation);

    await client.getSession({ signal: controller.signal });

    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(controller.signal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("still times out when the caller never aborts", async () => {
    const controller = new AbortController();
    const client = createClient(hangingFetch, 15);

    const error = (await captureRejection(
      client.getSession({ signal: controller.signal })
    )) as ExtractorApiError;

    expect(error.kind).toBe("timeout");
  });
});

describe("new endpoints", () => {
  it("posts pasted text to /extract and returns the success with its quota", async () => {
    const fetchImplementation = vi.fn<FetchSignature>(() =>
      Promise.resolve(jsonResponse(successEnvelope))
    );
    const client = createClient(fetchImplementation);
    const text = "Lentil soup: 1 cup red lentils, 1 onion. Simmer 25 minutes.";

    const response = await client.extractRecipeFromText({ text });

    const call = fetchImplementation.mock.calls[0];
    expect(call?.[0]).toBe("https://api.test/extract");
    expect(call?.[1]?.method).toBe("POST");
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ text, attempt: "fallback" });
    expect(response.status === "success" ? response.quota?.remaining : null).toBe(1);
  });

  it("reads the billing usage", async () => {
    const fetchImplementation = vi.fn<FetchSignature>(() =>
      Promise.resolve(
        jsonResponse({ billingEnabled: true, plan: "free", quota: successEnvelope.quota })
      )
    );
    const client = createClient(fetchImplementation);

    const usage = await client.getBillingUsage();

    expect(fetchImplementation.mock.calls[0]?.[0]).toBe("https://api.test/billing/usage");
    expect(fetchImplementation.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(usage.quota?.remaining).toBe(1);
  });
});
