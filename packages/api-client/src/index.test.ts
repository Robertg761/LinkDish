import { describe, expect, it, vi } from "vitest";

import { createExtractorApiClient, ExtractorApiError } from "./index.js";

const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: init.status ?? 200
  });

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
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ status: "deleted" }, { status: 403 }))
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
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        jsonResponse(
          {
            status: "failure",
            reason: "parse_failed",
            userMessage: "We could not identify a recipe."
          },
          { status: 500 }
        )
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
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(jsonResponse(successEnvelope)));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    const response = await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    expect(response.status).toBe("success");
  });

  it("reports contract mismatches on 2xx responses", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ status: "not-a-real-status" }))
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

    await expect(client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" })).rejects.toThrow();
  });

  it("passes an abort signal by default", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ authenticated: false }))
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.getSession();

    const init = fetchImplementation.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("passes an abort signal on extraction requests", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(jsonResponse(successEnvelope)));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    const init = fetchImplementation.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("base url normalization", () => {
  it("strips trailing slashes from the base url", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ authenticated: false }))
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test///",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.getSession();

    expect(fetchImplementation.mock.calls[0]?.[0]).toBe("https://api.test/auth/session");
  });

  it("uses the same base url for extraction requests", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(jsonResponse(successEnvelope)));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test/",
      fetchImplementation: fetchImplementation as unknown as typeof fetch
    });

    await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    expect(fetchImplementation.mock.calls[0]?.[0]).toBe("https://api.test/extract");
  });
});

describe("header merging", () => {
  it("sends a json content type only when there is a body", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ authenticated: false }))
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      getHeaders: () => ({ "x-linkdish-platform": "web_app" })
    });

    await client.getSession();

    const init = fetchImplementation.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;

    expect(headers["content-type"]).toBeUndefined();
    expect(headers["x-linkdish-platform"]).toBe("web_app");
    expect(init?.body).toBeUndefined();
  });

  it("lets caller headers win over the default content type", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ status: "sent", email: "a@b.com", expiresInSeconds: 600 }))
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

    const init = fetchImplementation.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;

    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(headers.authorization).toBe("Bearer token");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ email: "a@b.com" }));
  });

  it("merges headers on extraction requests as well", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(jsonResponse(successEnvelope)));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation as unknown as typeof fetch,
      getHeaders: () => ({ "x-linkdish-platform": "android_app" })
    });

    await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    const init = fetchImplementation.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;

    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-linkdish-platform"]).toBe("android_app");
  });
});
