import { load } from "cheerio";

import { isSameRegistrableDomain } from "../source-detection/registrable-domain.js";
import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import {
  createTimeoutSignal,
  getContentTypeEssence,
  identifyingFetchHeaders,
  isHtmlLikeContentType,
  readLimitedResponseText
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";

/*
 * Searches a creator's own recipe site for a dish. Most food blogs run WordPress, whose search
 * API answers JSON ({ title, url } per post) without any page scraping; sites that turn the API
 * off still answer WordPress's /?s= search page, whose result headings link the posts.
 *
 * The site is named by page content (a Facebook page name), so it is treated like a URL a
 * person pasted: every hop is checked for a public address, and a redirect may only stay on the
 * same site (fedbysab.com to www.fedbysab.com). Results on other sites are dropped.
 */
export interface CreatorSiteSearchResult {
  title: string;
  url: string;
}

export interface SearchCreatorSiteOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  validateUrl?: ValidateSourceUrl | undefined;
}

const maxResults = 10;
const maxRedirects = 3;
const apiMaxBytes = 512 * 1024;
const pageMaxBytes = 2 * 1024 * 1024;

/* Listing and system pages a search page also links: never a single recipe. */
const nonPostPathPattern =
  /^\/(?:$|category\/|tag\/|author\/|page\/|search\/|feed\/?|wp-|comments\/|shop\/?|about\/?$|contact\/?$|privacy|terms|cart\/?|account\/?|recipes?\/?$|recipe-index\/?$)/iu;

const decodeTitle = (title: string): string => load(`<p>${title}</p>`)("p").text().trim();

const readSiteUrl = (href: string, base: string, domain: string): string | null => {
  try {
    const url = new URL(href, base);

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !isSameRegistrableDomain(url.hostname, domain) ||
      nonPostPathPattern.test(url.pathname) ||
      url.searchParams.has("s")
    ) {
      return null;
    }

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

const discardBody = (response: Response): void => {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;

  if (body && typeof body.cancel === "function") {
    void body.cancel().catch(() => undefined);
  }
};

/* GET with redirects followed by hand; null when the site does not answer 200. */
const fetchOnSite = async (
  startUrl: string,
  domain: string,
  accept: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  signal: AbortSignal
): Promise<{ response: Response; url: string } | null> => {
  let current = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(current);

    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      !isSameRegistrableDomain(parsed.hostname, domain) ||
      isSourceUrlRejection(await validateUrl(current))
    ) {
      return null;
    }

    const response = await fetchImplementation(current, {
      headers: { ...identifyingFetchHeaders, accept },
      redirect: "manual",
      signal
    });
    const location = response.headers.get("location");

    if (response.status >= 300 && response.status < 400 && location) {
      discardBody(response);
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      discardBody(response);
      return null;
    }

    return { response, url: current };
  }

  return null;
};

const searchWordPressApi = async (
  domain: string,
  query: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  signal: AbortSignal
): Promise<CreatorSiteSearchResult[] | null> => {
  const apiUrl = new URL(`https://${domain}/wp-json/wp/v2/search`);
  apiUrl.searchParams.set("search", query);
  apiUrl.searchParams.set("type", "post");
  apiUrl.searchParams.set("per_page", String(maxResults));
  apiUrl.searchParams.set("_fields", "title,url");

  const fetched = await fetchOnSite(
    apiUrl.toString(),
    domain,
    "application/json",
    fetchImplementation,
    validateUrl,
    signal
  );

  if (!fetched) {
    return null;
  }

  if (getContentTypeEssence(fetched.response.headers.get("content-type")) !== "application/json") {
    discardBody(fetched.response);
    return null;
  }

  let body: unknown;

  try {
    body = JSON.parse(await readLimitedResponseText(fetched.response, apiMaxBytes));
  } catch {
    return null;
  }

  if (!Array.isArray(body)) {
    return null;
  }

  const results: CreatorSiteSearchResult[] = [];

  for (const entry of body.slice(0, maxResults)) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const title = typeof record.title === "string" ? decodeTitle(record.title) : "";
    const url =
      typeof record.url === "string" ? readSiteUrl(record.url, fetched.url, domain) : null;

    if (title && url) {
      results.push({ title, url });
    }
  }

  return results;
};

const searchResultLinkSelector = [
  "article h1 a[href]",
  "article h2 a[href]",
  "article h3 a[href]",
  "article a[rel='bookmark'][href]",
  ".entry-title a[href]",
  ".post-title a[href]",
  "main h2 a[href]",
  "main h3 a[href]"
].join(", ");

const searchWordPressPage = async (
  domain: string,
  query: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  signal: AbortSignal
): Promise<CreatorSiteSearchResult[]> => {
  const pageUrl = new URL(`https://${domain}/`);
  pageUrl.searchParams.set("s", query);

  const fetched = await fetchOnSite(
    pageUrl.toString(),
    domain,
    identifyingFetchHeaders.accept,
    fetchImplementation,
    validateUrl,
    signal
  );

  if (!fetched) {
    return [];
  }

  if (!isHtmlLikeContentType(fetched.response.headers.get("content-type"))) {
    discardBody(fetched.response);
    return [];
  }

  const $ = load(await readLimitedResponseText(fetched.response, pageMaxBytes));
  const results = new Map<string, string>();

  for (const element of $(searchResultLinkSelector).toArray()) {
    const link = $(element);
    const url = readSiteUrl(link.attr("href") ?? "", fetched.url, domain);
    const title = link.text().replace(/\s+/gu, " ").trim() || link.attr("title")?.trim() || "";

    if (url && title && !results.has(url)) {
      results.set(url, title);
    }

    if (results.size >= maxResults) {
      break;
    }
  }

  return [...results].map(([url, title]) => ({ title, url }));
};

/**
 * The posts a creator's site lists for a search, best first as the site ranks them. Empty when
 * the site has no search LinkDish can read or finds nothing.
 */
export const searchCreatorSite = async (
  domain: string,
  query: string,
  fetchImplementation: typeof fetch,
  options: SearchCreatorSiteOptions
): Promise<CreatorSiteSearchResult[]> => {
  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const timeout = createTimeoutSignal(options.timeoutMs, options.signal);

  try {
    const fromApi = await searchWordPressApi(
      domain,
      query,
      fetchImplementation,
      validateUrl,
      timeout.signal
    );

    return (
      fromApi ??
      (await searchWordPressPage(domain, query, fetchImplementation, validateUrl, timeout.signal))
    );
  } finally {
    timeout.cleanup();
  }
};
