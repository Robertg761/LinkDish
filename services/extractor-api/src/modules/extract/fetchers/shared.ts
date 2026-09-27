import type { InternalFetchFailureKind } from "../types.js";

export const browserLikeHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
} as const;

const defaultBlockedPatterns = [
  /captcha/i,
  /attention required/i,
  /cf-chl/i,
  /cloudflare/i,
  /access denied/i,
  /are you human/i,
  /verify you are human/i,
  /safeguarding your website/i,
  /bigscoots/i,
  /automated queries/i,
  /unusual traffic/i,
  /security check/i
] as const;

const notFoundTitlePatterns = [
  /\b404\b/i,
  /\bpage not found\b/i,
  /\bnot found\b/i,
  /\bcontent unavailable\b/i
] as const;

const redirectHintPatterns = [
  /\bthis recipe has moved\b/i,
  /\bpage not found\b/i,
  /\bnot found\b/i
] as const;

/*
 * The extract path fetches attacker-supplied URLs, so response bodies are
 * streamed with a hard byte cap (mirroring the image proxy's readImageBody)
 * instead of being buffered with response.text(). Without this a URL that
 * streams hundreds of megabytes inside the fetch timeout window is buffered in
 * full and then re-parsed several times downstream, which OOMs a
 * memory-bounded serverless function.
 */
export class ResponseBodyTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`Response body exceeded the ${maxBytes} byte limit.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

const htmlLikeContentTypes = new Set([
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/plain",
  "text/xml"
]);

export const getContentTypeEssence = (value: string | null | undefined): string =>
  (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

export const isHtmlLikeContentType = (value: string | null | undefined): boolean => {
  const essence = getContentTypeEssence(value);

  /* Servers that omit content-type are common enough that we keep reading them. */
  return essence === "" || htmlLikeContentTypes.has(essence);
};

const getDeclaredContentLength = (response: Response): number | null => {
  const rawValue = response.headers?.get?.("content-length");

  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : null;
};

export const readLimitedResponseText = async (
  response: Response,
  maxBytes: number
): Promise<string> => {
  const declaredContentLength = getDeclaredContentLength(response);

  if (declaredContentLength !== null && declaredContentLength > maxBytes) {
    throw new ResponseBodyTooLargeError(maxBytes);
  }

  const body = response.body as ReadableStream<Uint8Array> | null | undefined;

  if (!body || typeof body.getReader !== "function") {
    /* Mocked or already-buffered responses still get the same cap. */
    const text = await response.text();

    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
    }

    return text;
  }

  const reader = body.getReader();
  /* Matches Response.text(), which always decodes as UTF-8. */
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let totalBytes = 0;

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      if (!result.value) {
        continue;
      }

      totalBytes += result.value.byteLength;

      if (totalBytes > maxBytes) {
        throw new ResponseBodyTooLargeError(maxBytes);
      }

      text += decoder.decode(result.value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  return text + decoder.decode();
};

export const sleep = async (durationMs: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

/*
 * A per-operation timeout that also follows an optional parent signal (the
 * request deadline, or a billing denial that cancels speculative work).
 * `timedOut()` distinguishes our own timeout from a parent abort, and `abort()`
 * cancels an operation whose result is no longer needed.
 */
export const createTimeoutSignal = (
  timeoutMs: number,
  parentSignal?: AbortSignal
): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
  abort: () => void;
} => {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeoutId = setTimeout(
    () => {
      didTimeOut = true;
      controller.abort(new Error(`timeout:${timeoutMs}`));
    },
    Math.max(0, timeoutMs)
  );
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
    timedOut: () => didTimeOut,
    abort: () => controller.abort(new Error("cancelled"))
  };
};

const hiddenElementNames = new Set(["noscript", "script", "style", "svg", "template"]);
const tagNamePattern = /^<([a-z][a-z0-9-]*)/i;

/* Challenge and wall pages are small; a long article is never "thin". */
const maxWallPageHtmlChars = 150_000;
const maxWallPageVisibleTextChars = 1_000;
const suspiciousStatusCodes = new Set([401, 402, 403, 429, 451, 503]);

/*
 * These scanners run on attacker-supplied markup before any DOM parse, so they
 * use forward-only indexOf scans (linear time) rather than backtracking
 * regular expressions.
 */
const extractTitleText = (html: string): string => {
  const lowerHtml = html.toLowerCase();
  const openIndex = lowerHtml.indexOf("<title");
  const contentStart = openIndex === -1 ? -1 : lowerHtml.indexOf(">", openIndex);
  const closeIndex = contentStart === -1 ? -1 : lowerHtml.indexOf("</title", contentStart);

  return closeIndex === -1
    ? ""
    : html
        .slice(contentStart + 1, closeIndex)
        .replace(/\s+/g, " ")
        .trim();
};

/* Readable text only: comments, scripts, styles, SVG and markup are dropped. */
export const extractVisibleHtmlText = (html: string): string => {
  const lowerHtml = html.toLowerCase();
  const parts: string[] = [];
  let index = 0;

  while (index < html.length) {
    const tagStart = html.indexOf("<", index);

    if (tagStart === -1) {
      parts.push(html.slice(index));
      break;
    }

    parts.push(html.slice(index, tagStart), " ");

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = html.indexOf(">", tagStart + 1);

    if (tagEnd === -1) {
      break;
    }

    const tagName = tagNamePattern.exec(html.slice(tagStart, Math.min(tagEnd, tagStart + 64)))?.[1];
    const normalizedTagName = tagName?.toLowerCase();

    if (normalizedTagName && hiddenElementNames.has(normalizedTagName)) {
      const closeIndex = lowerHtml.indexOf(`</${normalizedTagName}`, tagEnd + 1);
      const closeEnd = closeIndex === -1 ? -1 : html.indexOf(">", closeIndex);
      index = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }

    index = tagEnd + 1;
  }

  return parts.join("").replace(/\s+/g, " ").trim();
};

/*
 * Anti-bot markers used to be matched anywhere in the raw HTML, so ordinary
 * recipe pages that load cdnjs.cloudflare.com, the Cloudflare Insights beacon or
 * a reCAPTCHA comment form were flagged as blocked and paid for a 3-15 s
 * browser render. Markers now count when they are in the page title, or when
 * the response already looks like a wall: a blocking status (401/402/403/429/451/503),
 * where the raw markup is still inspected, or a page with almost no readable
 * text, where only the readable text is inspected.
 */
export const detectBlockedSignals = ({
  html,
  statusCode,
  extraPatterns = []
}: {
  html: string;
  statusCode: number;
  extraPatterns?: RegExp[];
}): string[] => {
  const blockedSignals: string[] = [];
  const patterns = [...defaultBlockedPatterns, ...extraPatterns];
  const title = extractTitleText(html);
  const suspiciousStatus = suspiciousStatusCodes.has(statusCode);

  if (statusCode === 403 || statusCode === 429) {
    blockedSignals.push(`status:${statusCode}`);
  }

  const visibleText =
    suspiciousStatus || html.length <= maxWallPageHtmlChars ? extractVisibleHtmlText(html) : null;
  const looksLikeWallPage =
    visibleText !== null && visibleText.length <= maxWallPageVisibleTextChars;
  const inspectedTexts = [
    title,
    ...(suspiciousStatus || looksLikeWallPage ? [visibleText ?? ""] : []),
    ...(suspiciousStatus ? [html] : [])
  ];

  for (const pattern of patterns) {
    if (inspectedTexts.some((text) => pattern.test(text))) {
      blockedSignals.push(pattern.source);
    }
  }

  if (/^just a moment/i.test(title)) {
    blockedSignals.push("challenge-title");
  }

  return [...new Set(blockedSignals)];
};

export const classifyFetchStatusCode = (statusCode: number): InternalFetchFailureKind | null => {
  if ([401, 402, 403, 429, 451].includes(statusCode)) {
    return "blocked";
  }

  if ([404, 410].includes(statusCode)) {
    return "not_found";
  }

  if (statusCode >= 500) {
    return "unreachable";
  }

  return null;
};

export const looksLikeNotFoundTitle = (title: string | null): boolean =>
  title ? notFoundTitlePatterns.some((pattern) => pattern.test(title)) : false;

const tokenizeUrlPath = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 && !["recipe", "recipes", "article", "blog", "videos"].includes(token)
    );

export const looksLikeUnrelatedRedirect = ({
  requestedUrl,
  finalUrl,
  title,
  html
}: {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  html: string;
}): boolean => {
  if (requestedUrl === finalUrl) {
    return false;
  }

  if (redirectHintPatterns.some((pattern) => pattern.test(title ?? "") || pattern.test(html))) {
    return true;
  }

  const requested = new URL(requestedUrl);
  const final = new URL(finalUrl);

  if (requested.hostname !== final.hostname) {
    return true;
  }

  const requestedTokens = tokenizeUrlPath(requested.pathname);
  const finalTokens = tokenizeUrlPath(final.pathname);

  if (requestedTokens.length === 0 || finalTokens.length === 0) {
    return false;
  }

  const overlap = requestedTokens.filter((token) => finalTokens.includes(token));

  return overlap.length === 0;
};
