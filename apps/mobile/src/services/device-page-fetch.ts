import { MAX_DEVICE_PAGE_HTML_CHARS } from "@linkdish/api-contracts";

/*
 * Some recipe sites (Allrecipes and the other People Inc brands) refuse every request from a
 * cloud server, but open for people. When /extract says a link was blocked and a device page is
 * welcome (`deviceFetchAvailable`), the app downloads the page over the person's own
 * connection and sends the HTML back to be read. It asks once, as itself (the app's own user
 * agent): if the site turns the app away too, that answer stands and the person is pointed to
 * Paste text. The app never poses as a browser to get past a site's checks.
 */

const DEVICE_PAGE_TIMEOUT_MS = 15_000;
/* A page this big is not a recipe page; reading it would only waste the person's data. */
const MAX_DOWNLOADED_PAGE_CHARS = 12_000_000;

const pageHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9"
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

const removableElements = ["script", "style", "svg"] as const;
const jsonScriptTypePattern = /\btype\s*=\s*["']?application\/(?:ld\+)?json/u;

/**
 * Drops what the API never reads (styles, SVG, comments and every script but JSON-LD/JSON data),
 * which makes a typical recipe page several times smaller to upload. The API parses what is left
 * with a real HTML parser and never renders it, so this only trims size; it is not a sanitizer.
 * A forward-only scan (linear time), not regular-expression replacement.
 */
export const slimPageHtml = (html: string): string => {
  /* ASCII-only folding: toLowerCase() turns "İ" into two code units and shifts every offset. */
  const lower = html.replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
  const parts: string[] = [];
  let kept = 0;
  let index = 0;

  while (index < html.length) {
    const tagStart = lower.indexOf("<", index);

    if (tagStart === -1) {
      break;
    }

    let removeUntil = -1;

    if (lower.startsWith("<!--", tagStart)) {
      const commentEnd = lower.indexOf("-->", tagStart + 4);
      removeUntil = commentEnd === -1 ? html.length : commentEnd + 3;
    } else {
      const name = removableElements.find(
        (element) =>
          lower.startsWith(`<${element}`, tagStart) &&
          /[\s/>]/u.test(lower.charAt(tagStart + element.length + 1))
      );

      if (name) {
        const openEnd = lower.indexOf(">", tagStart);
        const closeStart = openEnd === -1 ? -1 : lower.indexOf(`</${name}`, openEnd);
        const closeEnd = closeStart === -1 ? -1 : lower.indexOf(">", closeStart);
        const elementEnd = closeEnd === -1 ? html.length : closeEnd + 1;
        const keepsData =
          name === "script" &&
          openEnd !== -1 &&
          jsonScriptTypePattern.test(lower.slice(tagStart, openEnd));

        removeUntil = keepsData ? -1 : elementEnd;
        index = keepsData ? elementEnd : index;
      }
    }

    if (removeUntil === -1) {
      index = Math.max(index, tagStart + 1);
      continue;
    }

    parts.push(html.slice(kept, tagStart));
    kept = removeUntil;
    index = removeUntil;
  }

  parts.push(html.slice(kept));
  return parts.join("");
};

const downloadPage = async (
  url: string,
  fetchImplementation: FetchLike,
  controller: AbortController
): Promise<DevicePage | null> => {
  const response = await fetchImplementation(url, {
    headers: pageHeaders,
    method: "GET",
    signal: controller.signal
  });

  if (!response.ok) {
    return null;
  }

  const declaredLength = Number(response.headers.get("content-length"));

  if (
    !isHtmlContentType(response.headers.get("content-type")) ||
    declaredLength > MAX_DOWNLOADED_PAGE_CHARS
  ) {
    /* Stops the body download; React Native's fetch cannot read a body in bounded chunks. */
    controller.abort();
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

/** Downloads a recipe page on this device, as the app. Null when it got no readable page. */
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
    return await downloadPage(url, fetchImplementation, controller);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
