import { MAX_DEVICE_PAGE_HTML_CHARS } from "@linkdish/api-contracts";

/*
 * Some recipe sites (Allrecipes and the other People Inc brands) refuse every request from a
 * cloud server, but open for people. When /extract says a link was blocked and a page from the
 * person's phone is welcome (`deviceFetchAvailable`), the app offers to open the page in an
 * in-app browser view. The person sees the page load (and answers any check the site shows them
 * there, as in any browser); when they tap Save, the app takes the page they are looking at and
 * sends its HTML back to be read. The app never downloads the page behind the person's back and
 * never poses as another browser.
 */

export interface DevicePage {
  html: string;
  finalUrl?: string;
}

/** A page the person opened in the in-app browser view: its address and its HTML. */
export interface CapturedPage {
  href: string;
  html: string;
}

export type DevicePageProblem = "other_site" | "challenge" | "empty" | "too_large";

/* A page this big is not a recipe page; slimming it would only hold up the phone. */
const MAX_CAPTURED_PAGE_CHARS = 12_000_000;

const PAGE_SHOWN = "linkdish:page-shown";
const PAGE_CAPTURED = "linkdish:page-captured";

/* Only the top page speaks: ads and other frames inside it load the same script. */
const postFromTopPage = (payload: string): string =>
  `(function(){if(window.top!==window||!window.ReactNativeWebView){return;}` +
  `window.ReactNativeWebView.postMessage(JSON.stringify(${payload}));})();true;`;

/** Runs after each page load in the in-app browser view: tells the app which page is showing. */
export const PAGE_SHOWN_SCRIPT = postFromTopPage(
  `{type:${JSON.stringify(PAGE_SHOWN)},href:location.href,title:document.title}`
);

/**
 * Run when the person taps Save: sends back the page they are looking at. The nonce ties the
 * answer to that tap, so a message the page posts on its own is never taken for it.
 */
export const buildCaptureScript = (nonce: string): string =>
  postFromTopPage(
    `{type:${JSON.stringify(PAGE_CAPTURED)},nonce:${JSON.stringify(nonce)},` +
      `href:location.href,html:document.documentElement.outerHTML}`
  );

export type PageViewMessage =
  | { kind: "shown"; href: string; title: string }
  | { kind: "captured"; nonce: string; href: string; html: string };

/** Reads a message from the in-app browser view. Anything else the page posts is ignored. */
export const readPageViewMessage = (data: string): PageViewMessage | null => {
  try {
    const message: unknown = JSON.parse(data);

    if (typeof message !== "object" || message === null) {
      return null;
    }

    const { href, html, nonce, title, type } = message as Record<string, unknown>;

    if (typeof href !== "string") {
      return null;
    }

    if (type === PAGE_SHOWN) {
      return { kind: "shown", href, title: typeof title === "string" ? title : "" };
    }

    return type === PAGE_CAPTURED && typeof nonce === "string" && typeof html === "string"
      ? { kind: "captured", nonce, href, html }
      : null;
  } catch {
    return null;
  }
};

/* A challenge page's title says so; a normal page may still load Cloudflare's challenge script. */
export const looksLikeChallengePage = (html: string): boolean =>
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
 * The page must be on the site the person asked for, on a public name: a page on another site,
 * an IP address or a local name is never uploaded.
 */
export const isSameSitePublicPage = (requestedUrl: string, pageUrl: string): boolean => {
  try {
    const requested = new URL(requestedUrl);
    const page = new URL(pageUrl);

    return (
      /^https?:$/u.test(page.protocol) &&
      !isPrivateHost(page.hostname) &&
      siteKey(page.hostname) === siteKey(requested.hostname)
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

/**
 * A link copied out of Facebook (l.facebook.com/l.php?u=...) is just a wrapper; the API reads
 * its u= target, so the in-app browser opens that page. Mirrors the API's unwrapFacebookRedirect.
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

/**
 * Turns the page the person saved into what /extract takes, or says why it can't be sent: it
 * left the site, it is still the site's check, or it is empty or too big once slimmed.
 */
export const prepareCapturedPage = (
  requestedUrl: string,
  captured: CapturedPage
): { page: DevicePage } | { problem: DevicePageProblem } => {
  if (!isSameSitePublicPage(unwrapFacebookLinkWrapper(requestedUrl), captured.href)) {
    return { problem: "other_site" };
  }

  if (captured.html.length > MAX_CAPTURED_PAGE_CHARS) {
    return { problem: "too_large" };
  }

  if (looksLikeChallengePage(captured.html)) {
    return { problem: "challenge" };
  }

  const html = slimPageHtml(captured.html);

  if (html.trim().length === 0) {
    return { problem: "empty" };
  }

  if (html.length > MAX_DEVICE_PAGE_HTML_CHARS) {
    return { problem: "too_large" };
  }

  return { page: { html, finalUrl: captured.href } };
};

/** "www.allrecipes.com" -> "allrecipes.com", for messages. */
export const pageSiteLabel = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./iu, "");
  } catch {
    return "the site";
  }
};

/** What to tell the person when the page they saved can't be sent. */
export const pageProblemMessage = (problem: DevicePageProblem, url: string): string => {
  switch (problem) {
    case "other_site":
      return `This page isn't on ${pageSiteLabel(url)}. Go back to the recipe, then tap Save recipe.`;
    case "challenge":
      return `${pageSiteLabel(url)} is still checking the page. Wait for the recipe to show, then tap Save recipe.`;
    case "too_large":
      return "This page is too big for LinkDish to read. Copy the recipe from it and use Paste text instead.";
    case "empty":
      return "LinkDish couldn't read this page. Let it finish loading, then try again.";
  }
};
