import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpFetch: vi.fn(),
  browserFetch: vi.fn(),
  createBrowserFetcher: vi.fn()
}));

vi.mock("../fetchers/fetch-html-document.js", () => ({
  fetchHtmlDocument: mocks.httpFetch
}));

vi.mock("../fetchers/fetch-browser-document.js", () => ({
  createBrowserFetcher: mocks.createBrowserFetcher
}));

import { extractorApiEnv } from "../../../config/env";
import { createRequestDeadline, ExtractionCancelledError } from "../deadline";
import { HtmlFetchError } from "../fetchers/errors";

import { extractRecipe } from "./extract-recipe";
import { createDefaultExtractorRuntime } from "./runtime";

import type { ExtractorRuntime, FetchResult } from "../types";

const url = "https://blocked.example/recipe";
const renderedPage: FetchResult = {
  document: {
    kind: "html",
    url,
    finalUrl: url,
    html: "<html><body>Rendered</body></html>",
    contentType: "text/html",
    title: "Rendered",
    description: null,
    blockedSignals: [],
    statusCode: 200
  },
  mode: "browser",
  blockedSignals: []
};

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const originalBrowserEnabled = extractorApiEnv.BROWSER_FETCH_ENABLED;

beforeEach(() => {
  extractorApiEnv.BROWSER_FETCH_ENABLED = true;
  /* The site answers with a bot challenge, which escalates to a browser render. */
  mocks.httpFetch.mockRejectedValue(
    new HtmlFetchError("Blocked", "blocked", ["status_403"], 403, url)
  );
  mocks.browserFetch.mockResolvedValue(renderedPage);
  mocks.createBrowserFetcher.mockReturnValue({
    available: true,
    fetch: mocks.browserFetch,
    dispose: () => Promise.resolve()
  });
});

afterEach(() => {
  extractorApiEnv.BROWSER_FETCH_ENABLED = originalBrowserEnabled;
  vi.clearAllMocks();
});

describe("default runtime browser escalation", () => {
  it("waits for billing before starting a browser render", async () => {
    const runtime = createDefaultExtractorRuntime();
    const deadline = createRequestDeadline(30_000);
    const authorized = deferred<void>();

    const fetching = runtime.fetchHtmlDocument(url, {
      deadline,
      awaitAuthorized: () => authorized.promise
    });

    await vi.waitFor(() => {
      expect(mocks.httpFetch).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.createBrowserFetcher).not.toHaveBeenCalled();
    expect(mocks.browserFetch).not.toHaveBeenCalled();

    authorized.resolve();

    await expect(fetching).resolves.toMatchObject({ mode: "browser" });
    expect(mocks.browserFetch).toHaveBeenCalledTimes(1);
    deadline.dispose();
  });

  it("never launches the browser when billing denies the request", async () => {
    const runtime = createDefaultExtractorRuntime();
    const deadline = createRequestDeadline(30_000);

    await expect(
      runtime.fetchHtmlDocument(url, {
        deadline,
        awaitAuthorized: () =>
          Promise.reject(new ExtractionCancelledError("Billing did not authorize this."))
      })
    ).rejects.toBeInstanceOf(ExtractionCancelledError);

    expect(mocks.createBrowserFetcher).not.toHaveBeenCalled();
    expect(mocks.browserFetch).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("does not escalate a shell page to the browser before billing allows it", async () => {
    mocks.httpFetch.mockResolvedValue({
      ...renderedPage,
      mode: "http",
      document: {
        ...renderedPage.document,
        html: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
        title: null
      }
    });
    const runtime = createDefaultExtractorRuntime();
    const deadline = createRequestDeadline(30_000);

    await expect(
      runtime.fetchHtmlDocument(url, {
        deadline,
        awaitAuthorized: () => Promise.reject(new ExtractionCancelledError())
      })
    ).rejects.toBeInstanceOf(ExtractionCancelledError);

    expect(mocks.browserFetch).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("holds the render until an extraction's billing answer, and skips it on a denial", async () => {
    const defaultRuntime = createDefaultExtractorRuntime();
    delete defaultRuntime.extractionCache;
    delete defaultRuntime.fallbackHandoffStore;
    const runtime: ExtractorRuntime = {
      ...defaultRuntime,
      fallbackExtractor: { available: false, providerName: "none", extract: vi.fn() },
      validateSourceUrl: () => Promise.resolve({ safe: true })
    };
    const billing = deferred<boolean>();
    const extraction = extractRecipe({ url, attempt: "primary" }, runtime, {
      authorization: billing.promise
    });
    void extraction.catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.httpFetch).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.browserFetch).not.toHaveBeenCalled();

    billing.resolve(false);

    await expect(extraction).rejects.toBeInstanceOf(ExtractionCancelledError);
    expect(mocks.createBrowserFetcher).not.toHaveBeenCalled();
    expect(mocks.browserFetch).not.toHaveBeenCalled();
  });
});
