import { createHash } from "node:crypto";

import { detectHostedMediaSourceType } from "../source-detection/detect-source-from-url.js";
import { parseYouTubeVideoId } from "../source-detection/parse-youtube-video-id.js";

/*
 * Cache keys are derived from a canonical form of the requested URL, so the
 * same recipe shared with different tracking parameters, fragments, host
 * casing or a trailing slash maps to one entry. The canonical form is only a
 * key: pages are always fetched from the URL the user supplied.
 *
 * Fragments are dropped except route fragments (#/recipe/1, #!/recipe/1): a browser render
 * keeps the fragment, so a hash-routed app renders a different recipe for each one.
 */
const isRouteFragment = (hash: string): boolean =>
  hash.length > 2 && (hash.startsWith("#/") || hash.startsWith("#!"));

const trackingParameterNames = new Set(["fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "si"]);

const isTrackingParameter = (name: string): boolean => {
  const normalizedName = name.toLowerCase();
  return normalizedName.startsWith("utm_") || trackingParameterNames.has(normalizedName);
};

export const canonicalizeSourceUrl = (url: string): string => {
  const parsedUrl = new URL(url);

  if (detectHostedMediaSourceType(url)?.sourceType === "youtube") {
    const videoId = parseYouTubeVideoId(url);

    if (videoId) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    }
  }

  if (!isRouteFragment(parsedUrl.hash)) {
    parsedUrl.hash = "";
  }

  parsedUrl.hostname = parsedUrl.hostname.toLowerCase();

  const trackingNames = [...new Set(parsedUrl.searchParams.keys())].filter(isTrackingParameter);

  for (const name of trackingNames) {
    parsedUrl.searchParams.delete(name);
  }

  if (parsedUrl.search === "?") {
    parsedUrl.search = "";
  }

  if (parsedUrl.pathname.length > 1 && parsedUrl.pathname.endsWith("/")) {
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/u, "") || "/";
  }

  return parsedUrl.toString();
};

export const hashCanonicalSourceUrl = (url: string): string =>
  createHash("sha256").update(canonicalizeSourceUrl(url)).digest("hex");

const withoutCommonHostPrefix = (hostname: string): string =>
  hostname.toLowerCase().replace(/^(?:www\d*|m|amp)\./u, "");

/**
 * True when a fetch that started at `requestedUrl` ended on the same site:
 * the same canonical URL, the same host, or a parent/child host (apex↔www,
 * example.com↔recipes.example.com). Results are only cached under the
 * requested URL's key in that case, so an open redirect to another site can
 * never plant foreign content under a popular recipe's key.
 */
export const isSameSiteFetch = (requestedUrl: string, finalUrl: string): boolean => {
  try {
    if (canonicalizeSourceUrl(requestedUrl) === canonicalizeSourceUrl(finalUrl)) {
      return true;
    }

    const requested = new URL(requestedUrl);
    const final = new URL(finalUrl);

    if (requested.protocol !== "http:" && requested.protocol !== "https:") {
      return false;
    }

    if (final.protocol !== "http:" && final.protocol !== "https:") {
      return false;
    }

    const requestedHost = withoutCommonHostPrefix(requested.hostname);
    const finalHost = withoutCommonHostPrefix(final.hostname);

    return (
      requestedHost === finalHost ||
      requestedHost.endsWith(`.${finalHost}`) ||
      finalHost.endsWith(`.${requestedHost}`)
    );
  } catch {
    return false;
  }
};
