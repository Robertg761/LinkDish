import { load } from "cheerio";

import type { RecipeImage } from "../../../../../../packages/recipe-domain/src/index.js";

type RecipeImageSource = RecipeImage["source"];

const jsonLdImageTypes = new Set([
  "recipe",
  "article",
  "newsarticle",
  "blogposting",
  "videoobject"
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parsePositiveInt = (value: unknown): number | undefined => {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const normalizeImageUrl = (url: string | null | undefined, baseUrl: string): string | null => {
  const trimmedUrl = url?.trim();

  if (!trimmedUrl || trimmedUrl.startsWith("data:")) {
    return null;
  }

  try {
    return new URL(trimmedUrl, baseUrl).toString();
  } catch {
    return null;
  }
};

const withOptionalDimensions = (
  image: Pick<RecipeImage, "source" | "url">,
  dimensions?: {
    height?: unknown;
    width?: unknown;
  }
): RecipeImage => {
  const width = parsePositiveInt(dimensions?.width);
  const height = parsePositiveInt(dimensions?.height);

  return {
    ...image,
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
};

const imageFromJsonLdValue = (
  value: unknown,
  baseUrl: string
): Omit<RecipeImage, "source"> | null => {
  if (typeof value === "string") {
    const url = normalizeImageUrl(value, baseUrl);
    return url ? { url } : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const image = imageFromJsonLdValue(entry, baseUrl);

      if (image) {
        return image;
      }
    }

    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const url =
    typeof value.url === "string"
      ? value.url
      : typeof value.contentUrl === "string"
        ? value.contentUrl
        : undefined;
  const normalizedUrl = normalizeImageUrl(url, baseUrl);

  return normalizedUrl
    ? withOptionalDimensions(
        {
          url: normalizedUrl,
          source: "jsonld"
        },
        {
          height: value.height,
          width: value.width
        }
      )
    : null;
};

const getJsonLdTypes = (value: unknown): string[] => {
  const types = Array.isArray(value) ? value : [value];
  return types.map((type) => String(type).toLowerCase());
};

const findJsonLdImage = (value: unknown, baseUrl: string): RecipeImage | null => {
  const queue: unknown[] = Array.isArray(value) ? Array.from(value as unknown[]) : [value];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!isRecord(current)) {
      continue;
    }

    const graph = current["@graph"];

    if (Array.isArray(graph)) {
      queue.push(...(graph as unknown[]));
    }

    if (!getJsonLdTypes(current["@type"]).some((type) => jsonLdImageTypes.has(type))) {
      continue;
    }

    const image = imageFromJsonLdValue(current.image, baseUrl);

    if (image) {
      return {
        ...image,
        source: "jsonld"
      };
    }
  }

  return null;
};

const looksLikeChromeImage = (url: string): boolean =>
  /(?:logo|icon|sprite|avatar|badge|pixel|spacer|placeholder|tracking|\.svg(?:\?|$))/iu.test(url);

const getMetaContent = ($: ReturnType<typeof load>, selectors: string[]): string | null => {
  for (const selector of selectors) {
    const content = $(selector).first().attr("content")?.trim();

    if (content) {
      return content;
    }
  }

  return null;
};

const imageFromMeta = (
  $: ReturnType<typeof load>,
  baseUrl: string,
  source: RecipeImageSource,
  selectors: string[],
  dimensionSelectors?: {
    height: string[];
    width: string[];
  }
): RecipeImage | null => {
  const url = normalizeImageUrl(getMetaContent($, selectors), baseUrl);

  if (!url) {
    return null;
  }

  return withOptionalDimensions(
    {
      source,
      url
    },
    {
      height: dimensionSelectors ? getMetaContent($, dimensionSelectors.height) : undefined,
      width: dimensionSelectors ? getMetaContent($, dimensionSelectors.width) : undefined
    }
  );
};

export const captureRecipeImage = (html: string, baseUrl: string): RecipeImage | null => {
  const $ = load(html);

  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const image = findJsonLdImage(JSON.parse($(script).text()), baseUrl);

      if (image) {
        return image;
      }
    } catch {
      continue;
    }
  }

  const openGraphImage = imageFromMeta(
    $,
    baseUrl,
    "og",
    ['meta[property="og:image:secure_url"]', 'meta[property="og:image"]', 'meta[name="og:image"]'],
    {
      height: ['meta[property="og:image:height"]', 'meta[name="og:image:height"]'],
      width: ['meta[property="og:image:width"]', 'meta[name="og:image:width"]']
    }
  );

  if (openGraphImage) {
    return openGraphImage;
  }

  const twitterImage = imageFromMeta($, baseUrl, "twitter", [
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]'
  ]);

  if (twitterImage) {
    return twitterImage;
  }

  let bestContentImage: (RecipeImage & { area: number }) | null = null;

  for (const element of $("img").toArray()) {
    const rawUrl =
      $(element).attr("src") ??
      $(element).attr("data-src") ??
      $(element).attr("data-lazy-src") ??
      $(element).attr("data-original");
    const url = normalizeImageUrl(rawUrl, baseUrl);

    if (!url || looksLikeChromeImage(url)) {
      continue;
    }

    const width = parsePositiveInt($(element).attr("width"));
    const height = parsePositiveInt($(element).attr("height"));
    const area = width && height ? width * height : 0;

    if (area > 0 && area < 40_000) {
      continue;
    }

    if (!bestContentImage || area > bestContentImage.area) {
      bestContentImage = {
        source: "content",
        url,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        area
      };
    }
  }

  if (!bestContentImage) {
    return null;
  }

  return {
    source: bestContentImage.source,
    url: bestContentImage.url,
    ...(bestContentImage.width ? { width: bestContentImage.width } : {}),
    ...(bestContentImage.height ? { height: bestContentImage.height } : {})
  };
};
