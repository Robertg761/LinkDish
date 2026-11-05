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

/* A challenge page's title says so; a normal page may still load Cloudflare's challenge script. */
const looksLikeChallengePage = (html: string): boolean =>
  /<title[^>]*>\s*(?:just a moment|attention required)/iu.test(html);

/* "www.allrecipes.com" and "allrecipes.com" share "allrecipes.com". */
const siteKey = (hostname: string): string => hostname.toLowerCase().split(".").slice(-2).join(".");

const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^[\d.]+$/u.test(host) ||
    host.includes(":")
  );
};

/**
 * The page must have stayed on the site the person asked for, on a public name: a redirect to
 * another site, an IP address or a local name is never uploaded.
 */
const isSameSitePublicPage = (requestedUrl: string, finalUrl: string): boolean => {
  try {
    const requested = new URL(requestedUrl);
    const final = new URL(finalUrl);

    return (
      /^https?:$/u.test(final.protocol) &&
      !isPrivateHost(final.hostname) &&
      siteKey(final.hostname) === siteKey(requested.hostname)
    );
  } catch {
    return false;
  }
};

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
        /* <svg aria-hidden="true"/> has no closing tag: it ends where it opens. */
        const selfClosing = openEnd > 0 && lower.charAt(openEnd - 1) === "/";
        const closeStart = openEnd === -1 || selfClosing ? -1 : lower.indexOf(`</${name}`, openEnd);
        const closeEnd = closeStart === -1 ? -1 : lower.indexOf(">", closeStart);
        const elementEnd = selfClosing ? openEnd + 1 : closeEnd === -1 ? html.length : closeEnd + 1;
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

  const finalUrl = response.url || url;

  if (!response.ok || !isSameSitePublicPage(url, finalUrl)) {
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

  return { html: slim, finalUrl };
};

/**
 * A link copied out of Facebook (l.facebook.com/l.php?u=...) is just a wrapper; the API reads
 * its u= target, so the phone downloads that page too. Mirrors the API's unwrapFacebookRedirect.
 */
export const unwrapFacebookLinkWrapper = (url: string): string => {
  let current = url;

  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const parsed = new URL(current);
      const host = parsed.hostname.toLowerCase();
      const target = parsed.searchParams.get("u");

      if ((host !== "l.facebook.com" && host !== "lm.facebook.com") || !target) {
        return current;
      }

      const targetUrl = new URL(target);

      if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
        return current;
      }

      current = targetUrl.toString();
    } catch {
      return current;
    }
  }

  return current;
};

/** Downloads a recipe page on this device, as the app. Null when it got no readable page. */
export const fetchPageOnDevice = async (
  url: string,
  options: { fetchImplementation?: FetchLike; timeoutMs?: number } = {}
): Promise<DevicePage | null> => {
  if (!isSameSitePublicPage(url, url)) {
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
