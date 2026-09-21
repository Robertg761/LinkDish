import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiClientMocks = vi.hoisted(() => ({
  capturedOptions: null as { getHeaders: () => Promise<Record<string, string>> } | null
}));

vi.mock("@linkdish/api-client", () => ({
  createExtractorApiClient: (options: { getHeaders: () => Promise<Record<string, string>> }) => {
    apiClientMocks.capturedOptions = options;
    return {};
  },
  ExtractorApiError: class ExtractorApiError extends Error {}
}));

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
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still builds request headers when localStorage throws on write", async () => {
    await import("./client");
    const options = apiClientMocks.capturedOptions;
    expect(options).not.toBeNull();

    blockStorageWrites();

    const headers = await options!.getHeaders();

    expect(headers["x-linkdish-platform"]).toBe("web_app");
    expect(headers["x-linkdish-client-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(headers["x-linkdish-session-id"]).toBeTruthy();
  });

  it("keeps the client id and session id stable across requests without storage", async () => {
    await import("./client");
    const options = apiClientMocks.capturedOptions;

    blockStorageWrites();

    const first = await options!.getHeaders();
    const second = await options!.getHeaders();

    expect(second["x-linkdish-client-id"]).toBe(first["x-linkdish-client-id"]);
    expect(second["x-linkdish-session-id"]).toBe(first["x-linkdish-session-id"]);
  });
});
