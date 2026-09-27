import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiClientMocks = vi.hoisted(() => ({
  capturedOptions: null as { getHeaders: () => Promise<Record<string, string>> } | null,
  createCalls: 0,
  getSession: vi.fn()
}));

vi.mock("@linkdish/api-client", () => {
  return {
    createExtractorApiClient: (options: { getHeaders: () => Promise<Record<string, string>> }) => {
      apiClientMocks.capturedOptions = options;
      apiClientMocks.createCalls += 1;
      return { getSession: apiClientMocks.getSession };
    },
    ExtractorApiError: class ExtractorApiError extends Error {
      public constructor(
        message: string,
        public readonly statusCode: number,
        public readonly details?: unknown
      ) {
        super(message);
        this.name = "ExtractorApiError";
      }
    }
  };
});

const blockStorageWrites = () => {
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    // Matches Safari Private Browsing / "block all cookies" behaviour.
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => null);
};

describe("api client headers in a storage-blocked browser", () => {
  beforeEach(() => {
    localStorage.clear();
    apiClientMocks.capturedOptions = null;
    apiClientMocks.createCalls = 0;
    apiClientMocks.getSession.mockReset().mockResolvedValue({ authenticated: false });
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still builds request headers when localStorage throws on write", async () => {
    const { buildApiRequestHeaders } = await import("./client");

    blockStorageWrites();

    const headers = await buildApiRequestHeaders();

    expect(headers["x-linkdish-platform"]).toBe("web_app");
    expect(headers["x-linkdish-client-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(headers["x-linkdish-session-id"]).toBeTruthy();
  });

  it("keeps the client id and session id stable across requests without storage", async () => {
    const { buildApiRequestHeaders } = await import("./client");

    blockStorageWrites();

    const first = await buildApiRequestHeaders();
    const second = await buildApiRequestHeaders();

    expect(second["x-linkdish-client-id"]).toBe(first["x-linkdish-client-id"]);
    expect(second["x-linkdish-session-id"]).toBe(first["x-linkdish-session-id"]);
  });

  it("sends the registered auth token", async () => {
    const { buildApiRequestHeaders, registerAuthTokenProvider } = await import("./client");
    registerAuthTokenProvider(() => Promise.resolve("token_123"));

    expect((await buildApiRequestHeaders()).authorization).toBe("Bearer token_123");
  });
});

describe("lazy api client", () => {
  beforeEach(() => {
    apiClientMocks.capturedOptions = null;
    apiClientMocks.createCalls = 0;
    apiClientMocks.getSession.mockReset().mockResolvedValue({ authenticated: false });
    vi.resetModules();
  });

  it("loads the real client on the first request and reuses it", async () => {
    const { apiClient } = await import("./client");
    expect(apiClientMocks.createCalls).toBe(0);

    await expect(apiClient.getSession()).resolves.toEqual({ authenticated: false });
    await apiClient.getSession();

    expect(apiClientMocks.createCalls).toBe(1);
    expect(apiClientMocks.capturedOptions?.getHeaders).toBeTypeOf("function");
  });

  it("re-types API errors as the web ExtractorApiError", async () => {
    const packageModule = await import("@linkdish/api-client");
    const { apiClient, ExtractorApiError, isExtractorApiError } = await import("./client");
    apiClientMocks.getSession.mockRejectedValue(
      new packageModule.ExtractorApiError("Extractor API request failed.", 404, { message: "Gone" })
    );

    const error: unknown = await apiClient.getSession().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractorApiError);
    expect(error).toMatchObject({ details: { message: "Gone" }, statusCode: 404 });
    expect(isExtractorApiError(error)).toBe(true);
  });

  it("turns synchronous validation throws into rejections", async () => {
    const { apiClient } = await import("./client");
    apiClientMocks.getSession.mockImplementation(() => {
      throw new Error("Invalid input");
    });

    const request = apiClient.getSession();

    await expect(request).rejects.toThrow("Invalid input");
  });
});
