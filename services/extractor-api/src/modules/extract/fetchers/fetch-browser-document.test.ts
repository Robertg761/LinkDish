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
