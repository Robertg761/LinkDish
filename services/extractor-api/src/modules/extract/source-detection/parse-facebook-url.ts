/*
 * Facebook link forms. Every host is matched exactly or as a subdomain, so lookalikes such as
 * notfacebook.com or facebook.com.example.net are never Facebook.
 *
 *   post      a single post, photo, video or reel, as a www.facebook.com URL that can be fetched
 *   short     fb.me, fb.watch and /share/ links: redirect tokens that must be followed first
 *   redirect  l.facebook.com and lm.facebook.com link wrappers, whose u= is the real target
 *   other     any other Facebook page (profiles, groups, events, the home page...)
 */
export const FACEBOOK_ORIGIN = "https://www.facebook.com";

export type FacebookLink =
  | { kind: "post"; url: string; isVideo: boolean }
  | { kind: "short"; url: string }
  | { kind: "redirect"; target: string }
  | { kind: "other" };

const matchesHostname = (hostname: string, expected: string): boolean =>
  hostname === expected || hostname.endsWith(`.${expected}`);

/** facebook.com and its subdomains, fb.com, fb.me and fb.watch. */
export const isFacebookHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase();

  return (
    matchesHostname(host, "facebook.com") ||
    matchesHostname(host, "fb.com") ||
    matchesHostname(host, "fb.me") ||
    host === "fb.watch"
  );
};

export const isFacebookUrl = (url: string): boolean => {
  try {
    return isFacebookHostname(new URL(url).hostname);
  } catch {
    return false;
  }
};

/* Query parameters that identify the content on the legacy script URLs; everything else is tracking. */
const keptQueryParameters: Record<string, string[]> = {
  "/permalink.php": ["story_fbid", "id"],
  "/story.php": ["story_fbid", "id"],
  "/photo.php": ["fbid", "set"],
  "/photo": ["fbid", "set"],
  "/video.php": ["v"],
  "/watch": ["v"],
  "/watch/live": ["v"]
};

const canonicalFacebookUrl = (parsedUrl: URL, requiredParameters: string[] = []): string | null => {
  const pathname = parsedUrl.pathname.replace(/\/{2,}/gu, "/");
  const kept = keptQueryParameters[pathname.replace(/\/+$/u, "").toLowerCase()] ?? [];
  const search = new URLSearchParams();

  for (const name of kept) {
    const value = parsedUrl.searchParams.get(name);

    if (value) {
      search.set(name, value);
    }
  }

  if (requiredParameters.some((name) => !search.get(name))) {
    return null;
  }

  const query = search.toString();

  return `${FACEBOOK_ORIGIN}${pathname}${query ? `?${query}` : ""}`;
};

const idSegment = "[A-Za-z0-9_.=-]+";

/* /<page>/posts/<id>, /<page>/posts/<slug>/<id>, /groups/<group>/posts/<id>, /groups/<group>/permalink/<id> */
const postPathPattern = new RegExp(
  `^/(?:groups/[^/]+/(?:posts|permalink)|[^/]+/posts)/${idSegment}(?:/${idSegment})?/?$`,
  "iu"
);
/* /reel/<id>, /<page>/reel/<id> */
const reelPathPattern = /^\/(?:[^/]+\/)?reels?\/\d+\/?$/iu;
/* /<page>/videos/<id>, /<page>/videos/<slug>/<id>, /videos/<id> */
const videoPathPattern = new RegExp(`^/(?:[^/]+/)?videos/(?:[^/]+/)?\\d+/?$`, "iu");
/* /<page>/photos/<album>/<id> (the album tab, /<page>/photos, is not a photo) */
const photoPathPattern = /^\/[^/]+\/photos\/(?:[^/]+\/)?\d+\/?$/iu;
/* /share/p/<token>, /share/r/<token>, /share/v/<token>, /share/<token> */
const sharePathPattern = /^\/share\/(?:(?:[prv]|reel|video)\/)?[A-Za-z0-9_-]+\/?$/iu;

const parseFacebookPath = (parsedUrl: URL): FacebookLink => {
  const pathname = parsedUrl.pathname.replace(/\/{2,}/gu, "/");
  const lowerPath = pathname.replace(/\/+$/u, "").toLowerCase();

  if (sharePathPattern.test(pathname)) {
    return { kind: "short", url: `${FACEBOOK_ORIGIN}${pathname}` };
  }

  if (reelPathPattern.test(pathname) || videoPathPattern.test(pathname)) {
    return { kind: "post", url: `${FACEBOOK_ORIGIN}${pathname}`, isVideo: true };
  }

  if (postPathPattern.test(pathname) || photoPathPattern.test(pathname)) {
    return { kind: "post", url: `${FACEBOOK_ORIGIN}${pathname}`, isVideo: false };
  }

  const scriptUrls: Record<string, { required: string[]; isVideo: boolean }> = {
    "/permalink.php": { required: ["story_fbid"], isVideo: false },
    "/story.php": { required: ["story_fbid"], isVideo: false },
    "/photo.php": { required: ["fbid"], isVideo: false },
    "/photo": { required: ["fbid"], isVideo: false },
    "/video.php": { required: ["v"], isVideo: true },
    "/watch": { required: ["v"], isVideo: true },
    "/watch/live": { required: ["v"], isVideo: true }
  };
  const script = scriptUrls[lowerPath];

  if (script) {
    const url = canonicalFacebookUrl(parsedUrl, script.required);
    return url ? { kind: "post", url, isVideo: script.isVideo } : { kind: "other" };
  }

  return { kind: "other" };
};

/**
 * What a URL is on Facebook, or null when it is not a Facebook URL at all. Post URLs are
 * canonicalized: https, www.facebook.com (m., mbasic., web., touch. and fb.com all map to it),
 * no fragment, and no query beyond the parameters that identify the content (fbclid,
 * mibextid, __cft__ and the like are dropped).
 */
export const parseFacebookLink = (url: string): FacebookLink | null => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  if (
    !isFacebookHostname(hostname) ||
    (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")
  ) {
    return null;
  }

  if (hostname === "l.facebook.com" || hostname === "lm.facebook.com") {
    const target = parsedUrl.searchParams.get("u");

    try {
      const targetUrl = target ? new URL(target) : null;

      return targetUrl && (targetUrl.protocol === "https:" || targetUrl.protocol === "http:")
        ? { kind: "redirect", target: targetUrl.toString() }
        : { kind: "other" };
    } catch {
      return { kind: "other" };
    }
  }

  if (hostname === "fb.watch" || matchesHostname(hostname, "fb.me")) {
    return /^\/[A-Za-z0-9_-]+\/?$/u.test(parsedUrl.pathname)
      ? { kind: "short", url: `https://${hostname}${parsedUrl.pathname}` }
      : { kind: "other" };
  }

  return parseFacebookPath(parsedUrl);
};

/**
 * A l.facebook.com or lm.facebook.com wrapper is just a link to its u= target (nested wrappers
 * included); any other URL is returned as it is. The target is not trusted: it goes through
 * the same safety checks as any URL a person pastes.
 */
export const unwrapFacebookRedirect = (url: string): string => {
  let current = url;

  for (let depth = 0; depth < 3; depth += 1) {
    const link = parseFacebookLink(current);

    if (link?.kind !== "redirect") {
      return current;
    }

    current = link.target;
  }

  return current;
};

/** A Facebook post, photo, video, reel, or a short/share link that leads to one. */
export const parseFacebookPost = (
  url: string
): Extract<FacebookLink, { kind: "post" | "short" }> | null => {
  const link = parseFacebookLink(url);

  return link?.kind === "post" || link?.kind === "short" ? link : null;
};
