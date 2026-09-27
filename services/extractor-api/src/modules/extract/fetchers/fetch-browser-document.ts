import { extractorApiEnv } from "../../../config/env.js";
import { buildHtmlSourceDocument } from "../html/parsed-html-document.js";
import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import { BrowserFetchError } from "./errors.js";
import { browserLikeHeaders, classifyFetchStatusCode, detectBlockedSignals } from "./shared.js";

import type { SourceUrlSafetyResult, ValidateSourceUrl } from "../source-url-safety.js";
import type { BrowserFetcher, BrowserFetchOptions, FetchResult } from "../types.js";

export { BrowserFetchError } from "./errors.js";

let activeBrowserFetches = 0;
const browserWaiters: Array<() => void> = [];

/*
 * A request waits for a browser slot for at most this long (less when its
 * deadline is closer), so a burst of renders on one instance cannot hold a
 * request past the function's maxDuration.
 */
export const defaultBrowserQueueTimeoutMs = 10_000;

const acquireBrowserSlot = async (
  limit: number,
  { signal, timeoutMs }: { signal?: AbortSignal | undefined; timeoutMs: number }
): Promise<void> => {
  if (signal?.aborted) {
    throw new BrowserFetchError("Browser fetch was cancelled before it started.", "timeout");
  }

  if (activeBrowserFetches < limit) {
    activeBrowserFetches += 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stopWaiting = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      const waiterIndex = browserWaiters.indexOf(waiter);

      if (waiterIndex !== -1) {
        browserWaiters.splice(waiterIndex, 1);
      }
    };
    const waiter = () => {
      stopWaiting();
      activeBrowserFetches += 1;
      resolve();
    };
    const onAbort = () => {
      stopWaiting();
      reject(new BrowserFetchError("Browser fetch was cancelled while queued.", "timeout"));
    };
    const timeoutId = setTimeout(
      () => {
        stopWaiting();
        reject(new BrowserFetchError("Timed out waiting for a browser slot.", "timeout"));
      },
      Math.max(0, timeoutMs)
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    browserWaiters.push(waiter);
  });
};

const releaseBrowserSlot = () => {
  activeBrowserFetches = Math.max(0, activeBrowserFetches - 1);
  const next = browserWaiters.shift();

  if (next) {
    next();
  }
};

class UnavailableBrowserFetcher implements BrowserFetcher {
  public readonly available = false;

  public fetch(): Promise<FetchResult> {
    return Promise.reject(new BrowserFetchError("Browser fetcher is unavailable.", "unreachable"));
  }

  public dispose(): Promise<void> {
    return Promise.resolve();
  }
}

type BrowserContextHandle = {
  route(
    url: string,
    handler: (route: {
      abort(): Promise<void>;
      continue(): Promise<void>;
      request(): { resourceType(): string; url(): string };
    }) => Promise<void> | void
  ): Promise<unknown>;
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
};

type PageHandle = {
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number }
  ): Promise<{ status(): number } | null>;
  waitForSelector(
    selector: string,
    options: { timeout: number; state?: "attached" | "visible" }
  ): Promise<void>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
};

type BrowserHandle = {
  newContext(options: {
    userAgent: string;
    locale: string;
    serviceWorkers: "block";
  }): Promise<BrowserContextHandle>;
  close(): Promise<void>;
};

/* Rendering only needs the DOM, so everything that does not build it is dropped. */
const blockedResourceTypes = new Set([
  "eventsource",
  "font",
  "image",
  "manifest",
  "media",
  "stylesheet",
  "texttrack",
  "websocket"
]);

const shouldAbortRequest = (resourceType: string, requestUrl: string): boolean => {
  if (blockedResourceTypes.has(resourceType)) {
    return true;
  }

  return [
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "facebook.net",
    "facebook.com/tr",
    "segment.io",
    "hotjar.com",
    "sentry.io",
    "beacon"
  ].some((pattern) => requestUrl.includes(pattern));
};

const readinessSelectors = [
  'script[type="application/ld+json"]',
  "[itemtype*='Recipe']",
  "article",
  "main",
  ".recipe-card",
  ".wprm-recipe-container"
] as const;

const isServerlessChromiumRuntime = (): boolean =>
  Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

const isBrowserClosedError = (error: unknown): boolean =>
  error instanceof Error && /browser.*closed|target.*closed|context.*closed/i.test(error.message);

const assertSafeBrowserUrl = async (url: string, validateUrl: ValidateSourceUrl): Promise<void> => {
  const safety = await validateUrl(url);

  if (isSourceUrlRejection(safety)) {
    throw new BrowserFetchError(
      `Browser fetch refused unsafe URL: ${safety.reason}`,
      safety.reason === "dns_lookup_failed" ? "unreachable" : "blocked",
      [`unsafe_url:${safety.reason}`],
      undefined,
      url
    );
  }
};

/*
 * A rendered page issues dozens of sub-requests to a handful of hosts. Each
 * one is still validated, but the DNS-backed check runs once per origin for the
 * lifetime of a single render instead of once per request.
 */
const createPerRenderUrlValidator = (validateUrl: ValidateSourceUrl): ValidateSourceUrl => {
  const resultsByOrigin = new Map<string, Promise<SourceUrlSafetyResult>>();

  return (url: string) => {
    let origin: string;

    try {
      const parsedUrl = new URL(url);
      origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
    } catch {
      return validateUrl(url);
    }

    let result = resultsByOrigin.get(origin);

    if (!result) {
      result = validateUrl(url);
      resultsByOrigin.set(origin, result);
    }

    return result;
  };
};

const launchBrowser = async (): Promise<BrowserHandle> => {
  if (isServerlessChromiumRuntime()) {
    const [{ chromium: playwrightChromium }, chromiumPackage] = await Promise.all([
      import("playwright-core"),
      import("@sparticuz/chromium")
    ]);
    const chromium = chromiumPackage.default;

    return playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true
    }) as unknown as Promise<BrowserHandle>;
  }

  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true }) as unknown as Promise<BrowserHandle>;
};

class AvailableBrowserFetcher implements BrowserFetcher {
  public readonly available = true;
  private browserPromise: Promise<BrowserHandle> | null = null;

  public constructor(
    private readonly timeoutMs: number,
    private readonly concurrency: number,
    private readonly validateUrl: ValidateSourceUrl,
    private readonly maxBytes: number
  ) {}

  private async getBrowser(): Promise<BrowserHandle> {
    if (isServerlessChromiumRuntime()) {
      return launchBrowser();
    }

    if (!this.browserPromise) {
      this.browserPromise = launchBrowser();
    }

    return this.browserPromise;
  }

  private async resetBrowser(): Promise<void> {
    const staleBrowserPromise = this.browserPromise;
    this.browserPromise = null;

    const browser = await staleBrowserPromise?.catch(() => null);
    await browser?.close().catch(() => undefined);
  }

  private async fetchWithBrowser(url: string, options: BrowserFetchOptions): Promise<FetchResult> {
    let browser: BrowserHandle | null = null;
    let context: BrowserContextHandle | null = null;
    let page: PageHandle | null = null;
    const signal = options.signal;
    const validateUrl = createPerRenderUrlValidator(this.validateUrl);
    const navigationTimeoutMs = Math.max(
      1,
      Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs)
    );
    const closeContextOnAbort = () => {
      void context?.close().catch(() => undefined);
    };

    signal?.addEventListener("abort", closeContextOnAbort, { once: true });

    try {
      await assertSafeBrowserUrl(url, this.validateUrl);

      browser = await this.getBrowser();
      context = await browser.newContext({
        userAgent: browserLikeHeaders["user-agent"],
        locale: "en-US",
        serviceWorkers: "block"
      });

      if (signal?.aborted) {
        throw new BrowserFetchError("Browser fetch was cancelled.", "timeout");
      }

      await context.route("**/*", async (route) => {
        const request = route.request();
        const requestUrl = request.url();

        if (shouldAbortRequest(request.resourceType(), requestUrl)) {
          await route.abort();
          return;
        }

        const requestSafety = await validateUrl(requestUrl);
        if (isSourceUrlRejection(requestSafety)) {
          await route.abort();
          return;
        }

        await route.continue();
      });
      page = await context.newPage();
      const activePage = page;

      await activePage.setExtraHTTPHeaders({
        "accept-language": browserLikeHeaders["accept-language"],
        "cache-control": "no-cache",
        pragma: "no-cache"
      });

      const response = await activePage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs
      });

      await Promise.any(
        readinessSelectors.map((selector) =>
          activePage.waitForSelector(selector, {
            timeout: 2_000,
            state: "attached"
          })
        )
      ).catch(() => undefined);

      const finalUrl = activePage.url();
      await assertSafeBrowserUrl(finalUrl, this.validateUrl);
      const html = await activePage.content();
      const statusCode = response?.status() ?? 200;
      const htmlBytes = Buffer.byteLength(html, "utf8");

      if (htmlBytes > this.maxBytes) {
        /* Bail before the document is parsed. */
        throw new BrowserFetchError(
          `Browser fetch returned ${htmlBytes} bytes, above the ${this.maxBytes} byte limit.`,
          "too_large",
          ["response_too_large"],
          statusCode,
          finalUrl
        );
      }

      const blockedSignals = detectBlockedSignals({
        html,
        statusCode,
        ...(options.blockSignalPatterns ? { extraPatterns: options.blockSignalPatterns } : {})
      });
      const failureKind = classifyFetchStatusCode(statusCode);

      if (failureKind) {
        throw new BrowserFetchError(
          `Browser fetch failed with status ${statusCode}.`,
          failureKind,
          blockedSignals,
          statusCode,
          finalUrl
        );
      }

      return {
        document: buildHtmlSourceDocument({
          url,
          finalUrl,
          html,
          contentType: "text/html",
          blockedSignals,
          statusCode
        }),
        mode: "browser",
        blockedSignals
      };
    } catch (error) {
      if (error instanceof BrowserFetchError) {
        throw error;
      }

      if (signal?.aborted) {
        throw new BrowserFetchError("Browser fetch was cancelled or ran out of time.", "timeout");
      }

      console.warn(
        JSON.stringify({
          event: "browser_fetch_failed",
          serverlessChromium: isServerlessChromiumRuntime(),
          message: error instanceof Error ? error.message : "Browser fetch failed."
        })
      );

      throw new BrowserFetchError(
        error instanceof Error ? error.message : "Browser fetch failed.",
        error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "unreachable"
      );
    } finally {
      signal?.removeEventListener("abort", closeContextOnAbort);

      if (page) {
        await page.close().catch(() => undefined);
      }

      if (context) {
        await context.close().catch(() => undefined);
      }

      if (browser && isServerlessChromiumRuntime()) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  public async fetch(url: string, options: BrowserFetchOptions = {}): Promise<FetchResult> {
    await acquireBrowserSlot(this.concurrency, {
      signal: options.signal,
      timeoutMs: Math.min(
        defaultBrowserQueueTimeoutMs,
        options.queueTimeoutMs ?? defaultBrowserQueueTimeoutMs
      )
    });

    try {
      try {
        return await this.fetchWithBrowser(url, options);
      } catch (error) {
        if (isBrowserClosedError(error) && !options.signal?.aborted) {
          await this.resetBrowser();
          return this.fetchWithBrowser(url, options);
        }

        throw error;
      }
    } finally {
      releaseBrowserSlot();
    }
  }

  public async dispose(): Promise<void> {
    if (!this.browserPromise) {
      return;
    }

    const browser = await this.browserPromise.catch(() => null);
    this.browserPromise = null;

    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export const createBrowserFetcher = (options: {
  enabled: boolean;
  timeoutMs: number;
  concurrency: number;
  maxBytes?: number;
  validateUrl?: ValidateSourceUrl;
}): BrowserFetcher =>
  options.enabled
    ? new AvailableBrowserFetcher(
        options.timeoutMs,
        options.concurrency,
        options.validateUrl ?? validatePublicSourceUrl,
        options.maxBytes ?? extractorApiEnv.FETCH_MAX_RESPONSE_BYTES
      )
    : new UnavailableBrowserFetcher();
