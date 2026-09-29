/**
 * Recipe URLs: canonical forms for duplicate detection, "same recipe" checks, and pulling the
 * first link out of shared text ("Look at this! https://site.com/recipe.").
 */

/** Query parameters that only track where a click came from. */
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "si",
  "ref_src",
  "ref_url",
  "_ga",
  "_gl",
  "yclid",
  "twclid",
  "ttclid",
  "srsltid",
  "epik",
  "s_kwcid",
  "cmpid",
  "mkt_tok"
]);
const TRACKING_PREFIX_PATTERN = /^(?:utm_|hsa_|pk_|mtm_)/i;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { "http:": "80", "https:": "443" };
const MULTIPLE_SLASHES_PATTERN = /\/{2,}/gu;
const TRAILING_SLASHES_PATTERN = /\/+$/u;
const LEADING_WWW_OR_MOBILE_PATTERN = /^(?:www\d?|m|mobile|amp)\./iu;
const AMP_PATH_PATTERN = /(?:\/amp\/?$|\/amp(?=\/))/iu;
const AMP_QUERY_VALUES = new Set(["amp", "1", "true"]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "music.youtube.com"
]);
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/u;
const YOUTUBE_PATH_ID_PATTERN = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,20})/u;
/** Text that looks like a link: an http(s) URL, or "www." followed by a host. */
const URL_IN_TEXT_PATTERN =
  /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`]*/iu;
/** Sentence punctuation that may follow a link; tested one character at a time from the end. */
const TRAILING_URL_PUNCTUATION_CHARACTER = /[),.!?;:\]'"]/u;
const SCHEME_PATTERN = /^https?:\/\//iu;

const countOf = (text: string, character: string): number => text.split(character).length - 1;

const parseUrl = (value: string): URL | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/**
 * The canonical form of a recipe URL, used to spot duplicates. It strips tracking parameters
 * (utm_*, fbclid, gclid, igshid, mc_cid, mc_eid, si, ref_src…) and the fragment, lowercases the
 * host, drops default ports and a trailing slash, collapses repeated slashes and sorts the
 * remaining query parameters. Path case is kept (some sites are case-sensitive). Invalid or
 * non-http(s) input comes back trimmed and unchanged.
 */
export const canonicalizeRecipeUrl = (url: string): string => {
  const parsed = parseUrl(url);

  if (!parsed) {
    return url.trim();
  }

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();

  if (parsed.port === DEFAULT_PORTS[parsed.protocol]) {
    parsed.port = "";
  }

  const kept = [...parsed.searchParams.entries()]
    .filter(
      ([name]) =>
        !TRACKING_PARAMETERS.has(name.toLowerCase()) && !TRACKING_PREFIX_PATTERN.test(name)
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  parsed.search = "";

  for (const [name, value] of kept) {
    parsed.searchParams.append(name, value);
  }

  const path = parsed.pathname
    .replace(MULTIPLE_SLASHES_PATTERN, "/")
    .replace(TRAILING_SLASHES_PATTERN, "");
  parsed.pathname = path.length > 0 ? path : "/";

  const serialized = parsed.toString();
  // URL keeps a lone "/" path; "https://site.com/" and "https://site.com" are the same page.
  return parsed.pathname === "/" && parsed.search === ""
    ? serialized.replace(TRAILING_SLASHES_PATTERN, "")
    : serialized;
};

const youtubeVideoId = (url: URL): string | null => {
  const host = url.hostname.replace(LEADING_WWW_OR_MOBILE_PATTERN, "");

  if (!YOUTUBE_HOSTS.has(host)) {
    return null;
  }

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return YOUTUBE_ID_PATTERN.test(id) ? id : null;
  }

  const watchId = url.searchParams.get("v");

  if (watchId && YOUTUBE_ID_PATTERN.test(watchId)) {
    return watchId;
  }

  return YOUTUBE_PATH_ID_PATTERN.exec(url.pathname)?.[1] ?? null;
};

/**
 * A looser identity for "is this the same recipe page": the canonical URL with www./m./amp.
 * host prefixes, AMP paths, scheme and all query parameters removed, and YouTube watch,
 * youtu.be, /shorts and /embed links reduced to the video id.
 */
export const recipeUrlIdentity = (url: string): string => {
  const parsed = parseUrl(canonicalizeRecipeUrl(url));

  if (!parsed) {
    return url.trim().toLowerCase();
  }

  const videoId = youtubeVideoId(parsed);

  if (videoId) {
    return `youtube:${videoId}`;
  }

  const host = parsed.hostname.replace(LEADING_WWW_OR_MOBILE_PATTERN, "");
  const path = parsed.pathname.replace(AMP_PATH_PATTERN, "").replace(TRAILING_SLASHES_PATTERN, "");
  const ampQuery = parsed.searchParams.get("amp");
  const meaningfulQuery = [...parsed.searchParams.entries()].filter(
    ([name, value]) =>
      !(name === "amp" && ampQuery != null && AMP_QUERY_VALUES.has(value.toLowerCase() || "amp"))
  );
  const query =
    meaningfulQuery.length > 0 ? `?${new URLSearchParams(meaningfulQuery).toString()}` : "";

  return `${host}${path}${query}`;
};

type RecipeLike =
  | string
  | { sourceUrl?: string | null | undefined; title?: string | null | undefined };

const TITLE_NORMALIZE_PATTERN = /[^\p{L}\p{N}]+/gu;
const DIACRITIC_PATTERN = /[̀-ͯ]/gu;

const normalizeTitle = (title: string | null | undefined): string =>
  (title ?? "")
    .normalize("NFD")
    .replace(DIACRITIC_PATTERN, "")
    .toLowerCase()
    .replace(TITLE_NORMALIZE_PATTERN, " ")
    .trim();

/**
 * The site + normalized title under which {@link isLikelySameRecipe} treats two recipes with
 * different links as the same one, or null without a title or a readable link. Equal keys mean
 * "same recipe"; it lets callers index recipes instead of comparing every pair.
 */
export const recipeSiteTitleKey = (recipe: {
  sourceUrl?: string | null | undefined;
  title?: string | null | undefined;
}): string | null => {
  const title = normalizeTitle(recipe.title);
  const host = parseUrl(recipe.sourceUrl ?? "")?.hostname.replace(
    LEADING_WWW_OR_MOBILE_PATTERN,
    ""
  );

  return title && host ? `${host}\u0000${title}` : null;
};

/**
 * Whether two recipes (or URLs) are probably the same one: the same page once tracking, www./m.,
 * AMP and trailing-slash differences are ignored, or the same YouTube video. When both sides
 * are recipes with titles and the URLs differ, identical normalized titles on the same site
 * also count ("…/recipe?print=1" vs "…/recipe").
 */
export const isLikelySameRecipe = (left: RecipeLike, right: RecipeLike): boolean => {
  const leftUrl = typeof left === "string" ? left : (left.sourceUrl ?? "");
  const rightUrl = typeof right === "string" ? right : (right.sourceUrl ?? "");

  if (leftUrl && rightUrl && recipeUrlIdentity(leftUrl) === recipeUrlIdentity(rightUrl)) {
    return true;
  }

  if (typeof left === "string" || typeof right === "string") {
    return false;
  }

  const leftKey = recipeSiteTitleKey(left);
  return leftKey !== null && leftKey === recipeSiteTitleKey(right);
};

/**
 * The first link in shared text, cleaned for import: trailing punctuation from the sentence is
 * dropped ("…/recipe)." → "…/recipe") unless it closes a parenthesis opened inside the URL, and
 * a scheme-less "www.site.com/x" gains https://. Returns null when there is no link.
 */
export const extractFirstUrl = (text: string): string | null => {
  const match = URL_IN_TEXT_PATTERN.exec(text);

  if (!match) {
    return null;
  }

  const link = match[0];
  // Counted once and kept current while trimming: recounting the whole link for every
  // character trimmed took seconds on a long run of ")".
  const opened = countOf(link, "(");
  let closed = countOf(link, ")");
  let end = link.length;

  while (end > 0 && TRAILING_URL_PUNCTUATION_CHARACTER.test(link[end - 1] ?? "")) {
    if (link[end - 1] === ")") {
      // A URL that opened a parenthesis keeps its closing one ("…/Pavlova_(cake)").
      if (opened >= closed) {
        break;
      }

      closed -= 1;
    }

    end -= 1;
  }

  const candidate = link.slice(0, end);
  const withScheme = SCHEME_PATTERN.test(candidate) ? candidate : `https://${candidate}`;
  return parseUrl(withScheme) ? withScheme : null;
};

/**
 * A short label for where a recipe came from: the host without "www." ("seriouseats.com"), or
 * "Scanned image" for photo imports. Falls back to "Saved recipe" for unreadable URLs.
 */
const IMPORTED_APP_URL_PATTERN = /linkdish\.app\/imports\/([a-z0-9-]+)\//iu;

/** A Map, so ".../imports/constructor/..." cannot reach Object.prototype.constructor. */
const IMPORTED_APP_LABELS: ReadonlyMap<string, string> = new Map([
  ["linkdish", "Imported from a LinkDish backup"],
  ["mela", "Imported from Mela"],
  ["paprika", "Imported from Paprika"]
]);

export const recipeSourceLabel = (sourceUrl: string): string => {
  if (sourceUrl.includes("linkdish.app/image-imports/")) {
    return "Scanned image";
  }

  // Pasted-text imports and recipes restored from other apps carry made-up linkdish.app URLs.
  if (sourceUrl.includes("linkdish.app/text-imports/")) {
    return "Pasted text";
  }

  const importedApp = IMPORTED_APP_URL_PATTERN.exec(sourceUrl)?.[1];

  if (importedApp !== undefined) {
    return IMPORTED_APP_LABELS.get(importedApp.toLowerCase()) ?? "Imported recipe";
  }

  const parsed = parseUrl(sourceUrl);
  return parsed ? parsed.hostname.replace(LEADING_WWW_OR_MOBILE_PATTERN, "") : "Saved recipe";
};
