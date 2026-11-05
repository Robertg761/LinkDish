import { MAX_DEVICE_PAGE_HTML_CHARS } from "@linkdish/api-contracts";

/*
 * Some recipe sites (Allrecipes and the other People Inc brands) refuse every request from a
 * cloud server, but open for people. When /extract says a link was blocked and a device page is
 * welcome (`deviceFetchAvailable`), the app downloads the page over the person's own
 * connection, the way a browser would, and sends the HTML back to be read.
 */

const DEVICE_PAGE_TIMEOUT_MS = 15_000;
/* A page this big is not a recipe page; reading it would only waste the person's data. */
const MAX_DOWNLOADED_PAGE_CHARS = 12_000_000;

const pageHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9"
} as const;

/* The second try looks like the phone's own browser, for sites that turn apps away. */
const browserHeaders = {
  ...pageHeaders,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
} as const;

export interface DevicePage {
  html: string;
  finalUrl?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const isHtmlContentType = (value: string | null): boolean =>
  !value || /\b(?:text\/html|application\/xhtml\+xml)\b/iu.test(value);

const looksLikeChallengePage = (html: string): boolean =>
  /<title[^>]*>\s*just a moment/iu.test(html) || /cf-chl-|challenge-platform/iu.test(html);

/**
 * Drops what the API never reads (styles, SVG, comments and every script but JSON-LD/JSON data),
 * which makes a typical recipe page several times smaller to upload.
 */
export const slimPageHtml = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/giu, "")
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/giu, (script, attributes: string) =>
      /\btype\s*=\s*["']?application\/(?:ld\+)?json/iu.test(attributes) ? script : ""
    );

const downloadOnce = async (
  url: string,
  headers: Record<string, string>,
  fetchImplementation: FetchLike,
  signal: AbortSignal
): Promise<DevicePage | null> => {
  const response = await fetchImplementation(url, { headers, method: "GET", signal });

  if (!response.ok || !isHtmlContentType(response.headers.get("content-type"))) {
    return null;
  }

  const html = await response.text();

  if (html.length > MAX_DOWNLOADED_PAGE_CHARS || looksLikeChallengePage(html)) {
    return null;
  }

  const slim = slimPageHtml(html);

  if (slim.length === 0 || slim.length > MAX_DEVICE_PAGE_HTML_CHARS) {
    return null;
  }

  const finalUrl = response.url && /^https?:\/\//iu.test(response.url) ? response.url : undefined;

  return { html: slim, ...(finalUrl ? { finalUrl } : {}) };
};

/**
 * Downloads a recipe page on this device: first as the app, then once more as the phone's
 * browser if the site turned the app away. Null when neither got a readable page.
 */
export const fetchPageOnDevice = async (
  url: string,
  options: { fetchImplementation?: FetchLike; timeoutMs?: number } = {}
): Promise<DevicePage | null> => {
  if (!/^https?:\/\//iu.test(url)) {
    return null;
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DEVICE_PAGE_TIMEOUT_MS);

  try {
    for (const headers of [pageHeaders, browserHeaders]) {
      try {
        const page = await downloadOnce(url, headers, fetchImplementation, controller.signal);

        if (page) {
          return page;
        }
      } catch {
        if (controller.signal.aborted) {
          return null;
        }
      }
    }

    return null;
  } finally {
    clearTimeout(timer);
  }
};
