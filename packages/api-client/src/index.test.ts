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

describe("recipe photos", () => {
  it("answers with an image the recipe can keep, at this client's API", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ height: 900, path: "/image/photos/abc.webp", width: 1200 }), {
        status: 201
      })
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.example.com/",
      fetchImplementation
    });

    await expect(
      client.uploadRecipePhoto({ dataUrl: "data:image/jpeg;base64,abc" })
    ).resolves.toEqual({
      height: 900,
      source: "content",
      url: "https://api.example.com/image/photos/abc.webp",
      width: 1200
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe("https://api.example.com/image/photos");
  });

  it("refuses anything but a picture before sending it", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = createExtractorApiClient({
      baseUrl: "https://api.example.com",
      fetchImplementation
    });

    await expect(
      client.uploadRecipePhoto({ dataUrl: "data:image/svg+xml;base64,abc" })
    ).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("account deletion", () => {
  const deleted = {
    providers: { apple: "not_revoked", clerk: "deleted", revenueCat: "no_record" },
    status: "deleted"
  };

  it("sends the Apple authorization code and returns each provider's result", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(deleted));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation
    });

    const response = await client.deleteAccount({
      appleAuthorizationCode: " apple-code ",
      confirmEmail: "cook@example.com"
    });
    const { input, init } = firstCall(fetchImplementation);

    expect(input).toBe("https://api.test/account");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(init?.body as string)).toEqual({
      appleAuthorizationCode: "apple-code",
      confirmEmail: "cook@example.com"
    });
    expect(response).toEqual(deleted);
  });

  it("leaves the Apple code out when there is none", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(deleted));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation
    });

    await client.deleteAccount({ confirmEmail: "cook@example.com" });

    expect(JSON.parse(firstCall(fetchImplementation).init?.body as string)).toEqual({
      confirmEmail: "cook@example.com"
    });
  });

  it("treats a deletion answer without provider results as a contract mismatch", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse({ status: "deleted" }));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation
    });

    await expect(client.deleteAccount({ confirmEmail: "cook@example.com" })).rejects.toThrow(
      "did not match the contract"
    );
  });

  it("waits longer than an ordinary request for the server's provider calls", async () => {
    vi.useFakeTimers();

    try {
      let aborted = false;
      const fetchImplementation = vi.fn<FetchSignature>(
        (_input, init) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("The operation was aborted."));
            });
            setTimeout(() => resolve(jsonResponse(deleted)), 45_000);
          })
      );
      const client = createExtractorApiClient({
        baseUrl: "https://api.test",
        fetchImplementation
      });

      const deleting = client.deleteAccount({ confirmEmail: "cook@example.com" });
      await vi.advanceTimersByTimeAsync(45_000);

      await expect(deleting).resolves.toEqual(deleted);
      expect(aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("error responses", () => {
  it("does not treat a 403 whose body matches the schema as success", async () => {
    const fetchImplementation = createFetchMock(() =>
      jsonResponse({ status: "deleted" }, { status: 403 })
    );
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation
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
      fetchImplementation: fetchImplementation
    });

    const error = await client
      .extractRecipe({ url: "https://example.com/soup", attempt: "primary" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect((error as ExtractorApiError).statusCode).toBe(500);
  });

  it("posts a saved recipe to /recipes/complete and returns the completed recipe", async () => {
    const completed = {
      ...successEnvelope,
      recipe: {
        ...successEnvelope.recipe,
        completion: {
          status: "ai_filled",
          ingredients: ["onion"],
          filledAt: "2026-11-03T12:00:00.000Z"
        }
      }
    };
    const fetchImplementation = createFetchMock(() => jsonResponse(completed));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation
    });

    const response = await client.completeRecipe({ recipe: successEnvelope.recipe as never });
    const { input, init } = firstCall(fetchImplementation);

    expect(input).toBe("https://api.test/recipes/complete");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ recipe: { title: "Soup" } });
    expect(response.status === "success" && response.recipe.completion?.status).toBe("ai_filled");
  });

  it("still returns 200 envelopes that match the contract", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(successEnvelope));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: fetchImplementation
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
      fetchImplementation: fetchImplementation
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
      fetchImplementation: hangingFetch,
      timeoutMs: 20
    });

    await expect(client.getSession()).rejects.toThrow();
  });

  it("aborts hanging extraction requests too", async () => {
    const client = createExtractorApiClient({
      baseUrl: "https://api.test",
      fetchImplementation: hangingFetch,
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
      fetchImplementation: fetchImplementation
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
      fetchImplementation: fetchImplementation
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
      fetchImplementation: fetchImplementation
    });

    await client.getSession();

    expect(firstCall(fetchImplementation).input).toBe("https://api.test/auth/session");
  });

  it("uses the same base url for extraction requests", async () => {
    const fetchImplementation = createFetchMock(() => jsonResponse(successEnvelope));
    const client = createExtractorApiClient({
      baseUrl: "https://api.test/",
      fetchImplementation: fetchImplementation
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
      fetchImplementation: fetchImplementation,
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
      fetchImplementation: fetchImplementation,
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
      fetchImplementation: fetchImplementation,
      getHeaders: () => ({ "x-linkdish-platform": "android_app" })
    });

    await client.extractRecipe({ url: "https://example.com/soup", attempt: "primary" });

    const { init } = firstCall(fetchImplementation);
    const headers = headersOf(init);

    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-linkdish-platform"]).toBe("android_app");
  });
});

describe("library sync", () => {
  it("pulls changes from a cursor and pushes a validated batch", async () => {
    const fetchMock = vi
      .fn<FetchSignature>()
      .mockResolvedValueOnce(jsonResponse({ changes: [], cursor: "7", hasMore: false }))
      .mockResolvedValueOnce(jsonResponse({ accepted: [], newer: [], rejected: [] }));
    const client = createExtractorApiClient({
      baseUrl: "https://api.example.com",
      fetchImplementation: fetchMock
    });

    await expect(client.pullLibraryChanges("5")).resolves.toEqual({
      changes: [],
      cursor: "7",
      hasMore: false
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/library/changes?since=5");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");

    const tombstone = {
      deleted: true as const,
      id: "recipe_1",
      kind: "recipe" as const,
      updatedAt: "2026-10-26T10:00:00.000Z"
    };

    await expect(client.pushLibraryChanges({ changes: [tombstone] })).resolves.toEqual({
      accepted: [],
      newer: [],
      rejected: []
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.example.com/library/changes");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      changes: [tombstone]
    });
  });

  it("sends nothing for an invalid push batch", async () => {
    const fetchMock = createFetchMock(() => jsonResponse({}));
    const client = createExtractorApiClient({
      baseUrl: "https://api.example.com",
      fetchImplementation: fetchMock
    });

    await expect(client.pushLibraryChanges({ changes: [] })).rejects.toMatchObject({
      kind: "validation"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
