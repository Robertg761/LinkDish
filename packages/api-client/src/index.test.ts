import { describe, expect, it, vi } from "vitest";

import { createExtractorApiClient, ExtractorApiError } from "./index.js";

const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: init.status ?? 200
  });

type FetchSignature = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const createFetchMock = (respond: () => Response) =>
  vi.fn<FetchSignature>(() => Promise.resolve(respond()));

type FetchMock = ReturnType<typeof createFetchMock>;

const firstCall = (mock: FetchMock) => {
  const call = mock.mock.calls[0];

  if (!call) {
    throw new Error("fetch was never called");
  }

  return { input: call[0], init: call[1] };
};

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  (init?.headers ?? {}) as Record<string, string>;

const successEnvelope = {
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
    provenance: ["visible-text"]
  }
} as const;

describe("error responses", () => {
  it("does not treat a 403 whose body matches the schema as success", async () => {
    const fetchImplementation = createFetchMock(() =>
      jsonResponse({ status: "deleted" }, { status: 403 })
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    const error = await client
      .deleteAccount({ confirmEmail: "cook@example.com" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect((error as ExtractorApiError).statusCode).toBe(403);
  });

  it("does not treat a 500 extraction envelope as success", async () => {
    const fetchImplementation = createFetchMock(() =>
      jsonResponse(
        {
          status: "failure",
          reason: "parse_failed",
          userMessage: "We could not identify a recipe."
        },
        { status: 500 }
      )
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    const error = await client
      .extractRecipe({ url: "https://example.com/soup", attempt: "primary" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect((error as ExtractorApiError).statusCode).toBe(500);
  });

  it("still returns 200 envelopes that match the contract", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(successEnvelope));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    const response = await client.extractRecipe({
      url: "https://example.com/soup",
      attempt: "primary"
    });

    expect(response.status).toBe("success");
  });

  it("reports contract mismatches on 2xx responses", async () => {
    const fetchImplementation = createFetchMock(() =>
      jsonResponse({ status: "not-a-real-status" })
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    const error = await client
      .deleteAccount({ confirmEmail: "cook@example.com" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect((error as ExtractorApiError).message).toContain("did not match the contract");
  });
});

describe("request timeouts", () => {
  const hangingFetch = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("The operation was aborted."));
      });
    });

  it("aborts requests that never settle", async () => {
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: hangingFetch as unknown as typeof fetch,
      timeoutMs: 20
    });

    await expect(client.getSession()).rejects.toThrow();
  });

  it("aborts hanging extraction requests too", async () => {
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: hangingFetch as unknown as typeof fetch,
      timeoutMs: 20
    });

    await expect(
      client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" })
    ).rejects.toThrow();
  });

  it("passes an abort signal by default", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse({ authenticated: false }));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.getSession();

    const { init } = firstCall(fetchImplementation);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("passes an abort signal on extraction requests", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(successEnvelope));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    const { init } = firstCall(fetchImplementation);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("base url normalization", () => {
  it("strips trailing slashes from the base url", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse({ authenticated: false }));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test///",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.getSession();

    expect(firstCall(fetchImplementation).input).toBe("https://api.test/auth/session");
  });

  it("uses the same base url for extraction requests", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(successEnvelope));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test/",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    expect(firstCall(fetchImplementation).input).toBe("https://api.test/extract");
  });
});

describe("header merging", () => {
  it("sends a json content type only when there is a body", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse({ authenticated: false }));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      getHeaders: () => ({ "x-linkdish-platform": "web_app" })
    });

    await client.getSession();

    const { init } = firstCall(fetchImplementation);
    const headers = headersOf(init);

    expect(headers["content-type"]).toBeUndefined();
    expect(headers["x-linkdish-platform"]).toBe("web_app");
    expect(init?.body).toBeUndefined();
  });

  it("lets caller headers win over the default content type", async () => {
    const fetchImplementation = createFetchMock(() =>
      jsonResponse({ status: "sent", email: "a@b.com", expiresInSeconds: 600 })
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      getHeaders: async () =>
        Promise.resolve({
          authorization: "Bearer token",
          "content-type": "application/json; charset=utf-8"
        })
    });

    await client.requestLoginCode({ email: "a@b.com" });

    const { init } = firstCall(fetchImplementation);
    const headers = headersOf(init);

    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(headers.authorization).toBe("Bearer token");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ email: "a@b.com" }));
  });

  it("merges headers on extraction requests as well", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(successEnvelope));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      getHeaders: () => ({ "x-linkdish-platform": "android_app" })
    });

    await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    const { init } = firstCall(fetchImplementation);
    const headers = headersOf(init);

    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-linkdish-platform"]).toBe("android_app");
  });
});
