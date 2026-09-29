import { beforeEach, describe, expect, it, vi } from "vitest";

type TestRoute = {
  abort: () => Promise<void>;
  continue: () => Promise<void>;
  request: () => {
    resourceType: () => string;
    url: () => string;
  };
};

const launchMock = vi.fn();

vi.mock("playwright", () => ({
  chromium: {
    launch: launchMock
  }
}));

import { createBrowserFetcher } from "./fetch-browser-document";

describe("createBrowserFetcher", () => {
  let browserMock: {
    newContext: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let contextMock: {
    route: ReturnType<typeof vi.fn>;
    newPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let pageMock: {
    setExtraHTTPHeaders: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    waitForSelector: ReturnType<typeof vi.fn>;
    content: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    waitForLoadState: ReturnType<typeof vi.fn>;
  };
  let validateUrlMock: ReturnType<typeof vi.fn>;

  const createEnabledFetcher = (validateUrl = validateUrlMock) =>
    createBrowserFetcher({
      enabled: true,
      timeoutMs: 2_000,
      concurrency: 1,
      validateUrl
    });

  beforeEach(() => {
    validateUrlMock = vi.fn().mockResolvedValue({
      safe: true
    });
    pageMock = {
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue({
        status: () => 200
      }),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      content: vi
        .fn()
        .mockResolvedValue(
          '<html><title>Fixture Recipe</title><main><script type="application/ld+json">{"@type":"Recipe"}</script></main></html>'
        ),
      url: vi.fn().mockReturnValue("https://example.com/final"),
      close: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined)
    };
    contextMock = {
      route: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(pageMock),
      close: vi.fn().mockResolvedValue(undefined)
    };
    browserMock = {
      newContext: vi.fn().mockResolvedValue(contextMock),
      close: vi.fn().mockResolvedValue(undefined)
    };
    launchMock.mockReset();
    launchMock.mockResolvedValue(browserMock);
  });

  it("captures final URL and status code without waiting for networkidle", async () => {
    const fetcher = createEnabledFetcher();

    const result = await fetcher.fetch("https://example.com/original");

    expect(result.mode).toBe("browser");
    expect(result.document.finalUrl).toBe("https://example.com/final");
    expect(result.document.statusCode).toBe(200);
    expect(pageMock.waitForLoadState).not.toHaveBeenCalled();
    expect(browserMock.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceWorkers: "block"
      })
    );
  });

  it("refuses a rendered document that exceeds the byte cap", async () => {
    pageMock.content.mockResolvedValue(`<html><body>${"a".repeat(200_000)}</body></html>`);
    const fetcher = createBrowserFetcher({
      enabled: true,
      timeoutMs: 2_000,
      concurrency: 1,
      maxBytes: 1_024,
      validateUrl: validateUrlMock
    });

    await expect(fetcher.fetch("https://example.com/huge")).rejects.toMatchObject({
      blockedSignals: ["response_too_large"],
      reason: "too_large"
    });
  });

  it("routes asset requests away during browser fetch", async () => {
    const fetcher = createEnabledFetcher();

    await fetcher.fetch("https://example.com/original");

    const routeHandlerCandidate: unknown = contextMock.route.mock.calls[0]?.[1];
    expect(typeof routeHandlerCandidate).toBe("function");

    if (typeof routeHandlerCandidate !== "function") {
      throw new Error("Expected route handler to be registered.");
    }

    const routeHandler = routeHandlerCandidate as (route: TestRoute) => Promise<void>;
    const imageRoute = {
      abort: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue(undefined),
      request: () => ({
        resourceType: () => "image",
        url: () => "https://cdn.example.com/image.jpg"
      })
    };
    const scriptRoute = {
      abort: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue(undefined),
      request: () => ({
        resourceType: () => "script",
        url: () => "https://example.com/app.js"
      })
    };

    await routeHandler(imageRoute);
    await routeHandler(scriptRoute);

    expect(imageRoute.abort).toHaveBeenCalled();
    expect(scriptRoute.continue).toHaveBeenCalled();
  });

  it("rejects non-http protocols before browser navigation", async () => {
    const fetcher = createBrowserFetcher({
      enabled: true,
      timeoutMs: 2_000,
      concurrency: 1
    });

    await expect(fetcher.fetch("file:///tmp/secret.html")).rejects.toMatchObject({
      blockedSignals: ["unsafe_url:unsupported_protocol"],
      finalUrl: "file:///tmp/secret.html",
      reason: "blocked"
    });
    expect(launchMock).not.toHaveBeenCalled();
    expect(pageMock.goto).not.toHaveBeenCalled();
  });

  it("aborts unsafe browser subresource requests", async () => {
    const validateUrl = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("127.0.0.1")
          ? {
              reason: "private_address" as const,
              safe: false as const
            }
          : {
              safe: true as const
            }
      )
    );
    const fetcher = createEnabledFetcher(validateUrl);

    await fetcher.fetch("https://example.com/original");

    const routeHandlerCandidate: unknown = contextMock.route.mock.calls[0]?.[1];
    expect(typeof routeHandlerCandidate).toBe("function");

    if (typeof routeHandlerCandidate !== "function") {
      throw new Error("Expected route handler to be registered.");
    }

    const routeHandler = routeHandlerCandidate as (route: TestRoute) => Promise<void>;
    const privateRoute = {
      abort: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue(undefined),
      request: () => ({
        resourceType: () => "script",
        url: () => "http://127.0.0.1/admin"
      })
    };

    await routeHandler(privateRoute);

    expect(privateRoute.abort).toHaveBeenCalled();
    expect(privateRoute.continue).not.toHaveBeenCalled();
  });

  it("rejects unsafe final URLs before reading browser content", async () => {
    const validateUrl = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("127.0.0.1")
          ? {
              reason: "private_address" as const,
              safe: false as const
            }
          : {
              safe: true as const
            }
      )
    );
    pageMock.url.mockReturnValue("http://127.0.0.1/admin");
    const fetcher = createEnabledFetcher(validateUrl);

    await expect(fetcher.fetch("https://example.com/original")).rejects.toMatchObject({
      blockedSignals: ["unsafe_url:private_address"],
      finalUrl: "http://127.0.0.1/admin",
      reason: "blocked"
    });
    expect(pageMock.content).not.toHaveBeenCalled();
  });

  it("returns not_found when the browser sees a 404 page", async () => {
    pageMock.goto.mockResolvedValue({
      status: () => 404
    });
    pageMock.content.mockResolvedValue(
      "<html><title>Page not found</title><main>missing</main></html>"
    );

    const fetcher = createEnabledFetcher();

    await expect(fetcher.fetch("https://example.com/missing")).rejects.toMatchObject({
      reason: "not_found",
      statusCode: 404
    });
  });

  it("gives up waiting for a busy browser slot instead of queueing past the deadline", async () => {
    let finishFirstRender: (() => void) | undefined;
    pageMock.goto.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstRender = () => resolve({ status: () => 200 });
        })
    );
    const fetcher = createEnabledFetcher();

    const firstFetch = fetcher.fetch("https://example.com/slow");
    await vi.waitFor(() => {
      expect(finishFirstRender).toBeDefined();
    });

    await expect(
      fetcher.fetch("https://example.com/queued", { queueTimeoutMs: 20 })
    ).rejects.toMatchObject({ name: "BrowserFetchError", reason: "timeout" });

    const cancellation = new AbortController();
    const cancelledFetch = fetcher.fetch("https://example.com/cancelled", {
      queueTimeoutMs: 5_000,
      signal: cancellation.signal
    });
    cancellation.abort();
    await expect(cancelledFetch).rejects.toMatchObject({ reason: "timeout" });

    finishFirstRender?.();
    await expect(firstFetch).resolves.toMatchObject({ mode: "browser" });
    await expect(fetcher.fetch("https://example.com/after")).resolves.toMatchObject({
      mode: "browser"
    });
  });

  it("caps navigation at the caller's budget and validates each sub-request origin once", async () => {
    const validateUrl = vi.fn(() => Promise.resolve({ safe: true as const }));
    const fetcher = createEnabledFetcher(validateUrl);

    await fetcher.fetch("https://example.com/original", { timeoutMs: 700 });

    expect(pageMock.goto).toHaveBeenCalledWith("https://example.com/original", {
      timeout: 700,
      waitUntil: "domcontentloaded"
    });

    const routeHandler = contextMock.route.mock.calls[0]?.[1] as (
      route: TestRoute
    ) => Promise<void>;
    const scriptRoute = (url: string) => ({
      abort: vi.fn().mockResolvedValue(undefined),
      continue: vi.fn().mockResolvedValue(undefined),
      request: () => ({ resourceType: () => "script", url: () => url })
    });
    validateUrl.mockClear();

    await routeHandler(scriptRoute("https://cdn.example.com/a.js"));
    await routeHandler(scriptRoute("https://cdn.example.com/b.js"));
    await routeHandler(scriptRoute("https://other.example.com/c.js"));

    expect(validateUrl).toHaveBeenCalledTimes(2);
  });

  it("drops stylesheets and sockets as well as media during a render", async () => {
    const fetcher = createEnabledFetcher();

    await fetcher.fetch("https://example.com/original");

    const routeHandler = contextMock.route.mock.calls[0]?.[1] as (
      route: TestRoute
    ) => Promise<void>;

    for (const resourceType of ["stylesheet", "websocket", "eventsource"]) {
      const route = {
        abort: vi.fn().mockResolvedValue(undefined),
        continue: vi.fn().mockResolvedValue(undefined),
        request: () => ({ resourceType: () => resourceType, url: () => "https://example.com/x" })
      };

      await routeHandler(route);
      expect(route.abort).toHaveBeenCalled();
    }
  });

  it("relaunches Chromium when a cached browser closes before context creation", async () => {
    const staleBrowserMock = {
      newContext: vi
        .fn()
        .mockRejectedValue(
          new Error("browser.newContext: Target page, context or browser has been closed")
        ),
      close: vi.fn().mockResolvedValue(undefined)
    };
    launchMock.mockResolvedValueOnce(staleBrowserMock).mockResolvedValueOnce(browserMock);

    const fetcher = createEnabledFetcher();

    const result = await fetcher.fetch("https://example.com/original");

    expect(result.mode).toBe("browser");
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(staleBrowserMock.close).toHaveBeenCalled();
    expect(browserMock.newContext).toHaveBeenCalledTimes(1);
  });
});
