import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import {
  browserLikeHeaders,
  buildHtmlSourceDocument,
  classifyFetchStatusCode,
  detectBlockedSignals
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { BrowserFetcher, FetchResult, InternalFetchFailureKind } from "../types.js";

export class BrowserFetchError extends Error {
  public constructor(
    message: string,
    public readonly reason: InternalFetchFailureKind,
    public readonly blockedSignals: string[] = [],
    public readonly statusCode?: number,
    public readonly finalUrl?: string
  ) {
    super(message);
    this.name = "BrowserFetchError";
  }
}

let activeBrowserFetches = 0;
const browserWaiters: Array<() => void> = [];

const acquireBrowserSlot = async (limit: number) => {
  if (activeBrowserFetches < limit) {
    activeBrowserFetches += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    browserWaiters.push(() => {
      activeBrowserFetches += 1;
      resolve();
    });
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
    throw new BrowserFetchError("Browser fetcher is unavailable.", "unreachable");
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

const shouldAbortRequest = (resourceType: string, requestUrl: string): boolean => {
  if (["image", "font", "media"].includes(resourceType)) {
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
    private readonly validateUrl: ValidateSourceUrl
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

  private async fetchWithBrowser(url: string): Promise<FetchResult> {
    let browser: BrowserHandle | null = null;
    let context: BrowserContextHandle | null = null;
    let page: PageHandle | null = null;

    try {
      await assertSafeBrowserUrl(url, this.validateUrl);

      browser = await this.getBrowser();
      context = await browser.newContext({
        userAgent: browserLikeHeaders["user-agent"],
        locale: "en-US",
        serviceWorkers: "block"
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const requestUrl = request.url();

        if (shouldAbortRequest(request.resourceType(), requestUrl)) {
          await route.abort();
          return;
        }

        const requestSafety = await this.validateUrl(requestUrl);
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
        timeout: this.timeoutMs
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
      const blockedSignals = detectBlockedSignals({
        html,
        statusCode
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

  public async fetch(url: string): Promise<FetchResult> {
    await acquireBrowserSlot(this.concurrency);

    try {
      try {
        return await this.fetchWithBrowser(url);
      } catch (error) {
        if (isBrowserClosedError(error)) {
          await this.resetBrowser();
          return this.fetchWithBrowser(url);
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
  validateUrl?: ValidateSourceUrl;
}): BrowserFetcher =>
  options.enabled
    ? new AvailableBrowserFetcher(
        options.timeoutMs,
        options.concurrency,
        options.validateUrl ?? validatePublicSourceUrl
      )
    : new UnavailableBrowserFetcher();
