import { getParsedHtmlDocument, type ParsedHtmlDocument } from "../html/parsed-html-document.js";

import type { RecipeImage } from "../../../../../../packages/recipe-domain/src/index.js";
import type { HtmlSourceDocument } from "../types.js";

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

type MetaSelector = readonly ["name" | "property", string];

/* First non-empty trimmed content, in selector order (same as `$(selector).first().attr()`). */
const getMetaContent = (
  parsed: ParsedHtmlDocument,
  selectors: readonly MetaSelector[]
): string | null => {
  for (const [attribute, value] of selectors) {
    const content = parsed.metaContent(attribute, value)?.trim();

    if (content) {
      return content;
    }
  }

  return null;
};

const imageFromMeta = (
  parsed: ParsedHtmlDocument,
  baseUrl: string,
  source: RecipeImageSource,
  selectors: readonly MetaSelector[],
  dimensionSelectors?: {
    height: readonly MetaSelector[];
    width: readonly MetaSelector[];
  }
): RecipeImage | null => {
  const url = normalizeImageUrl(getMetaContent(parsed, selectors), baseUrl);

  if (!url) {
    return null;
  }

  return withOptionalDimensions(
    {
      source,
      url
    },
    {
      height: dimensionSelectors ? getMetaContent(parsed, dimensionSelectors.height) : undefined,
      width: dimensionSelectors ? getMetaContent(parsed, dimensionSelectors.width) : undefined
    }
  );
};

export const captureRecipeImage = (
  source: HtmlSourceDocument | ParsedHtmlDocument | string,
  baseUrl: string
): RecipeImage | null => {
  const parsed = getParsedHtmlDocument(source);
  const { $ } = parsed;

  for (const block of parsed.jsonLdBlocks) {
    const image = findJsonLdImage(block, baseUrl);

    if (image) {
      return image;
    }
  }

  const openGraphImage = imageFromMeta(
    parsed,
    baseUrl,
    "og",
    [
      ["property", "og:image:secure_url"],
      ["property", "og:image"],
      ["name", "og:image"]
    ],
    {
      height: [
        ["property", "og:image:height"],
        ["name", "og:image:height"]
      ],
      width: [
        ["property", "og:image:width"],
        ["name", "og:image:width"]
      ]
    }
  );

  if (openGraphImage) {
    return openGraphImage;
  }

  const twitterImage = imageFromMeta(parsed, baseUrl, "twitter", [
    ["name", "twitter:image"],
    ["name", "twitter:image:src"]
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
