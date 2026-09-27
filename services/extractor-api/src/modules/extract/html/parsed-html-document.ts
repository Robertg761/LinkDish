import { load, type CheerioAPI } from "cheerio";

import type { HtmlSourceDocument } from "../types.js";

/*
 * A fetched page used to be re-parsed by cheerio five to ten times per import
 * (document metadata, shell/thin/not-found checks, source detection, the
 * JSON-LD reader, the extractor itself, hero image capture and every section
 * helper). A multi-megabyte page makes each parse cost tens of milliseconds, so
 * the fetchers now parse once and every later stage reads this shared view.
 *
 * The cheerio root is shared, so consumers must treat it as read-only. Code
 * that needs to strip nodes (the fallback prompt builder) parses its own copy.
 */
export class ParsedHtmlDocument {
  public readonly $: CheerioAPI;
  #jsonLdBlocks: unknown[] | undefined;
  #metaByAttribute: Map<string, string | undefined> | undefined;
  #titleText: string | undefined;
  #firstHeadingText: string | undefined;
  #bodyText: string | undefined;

  public constructor(public readonly html: string) {
    this.$ = load(html);
  }

  /** Successfully parsed `application/ld+json` blocks, in document order. */
  public get jsonLdBlocks(): readonly unknown[] {
    if (!this.#jsonLdBlocks) {
      const blocks: unknown[] = [];

      for (const script of this.$('script[type="application/ld+json"]').toArray()) {
        const rawValue = this.$(script).text().trim();

        if (!rawValue) {
          continue;
        }

        try {
          blocks.push(JSON.parse(rawValue) as unknown);
        } catch {
          continue;
        }
      }

      this.#jsonLdBlocks = blocks;
    }

    return this.#jsonLdBlocks;
  }

  /**
   * Equivalent to `$('meta[<attribute>="<value>"]').attr("content")`: the content of the
   * first matching meta tag in document order, even when that tag has no content.
   */
  public metaContent(attribute: "name" | "property", value: string): string | undefined {
    if (!this.#metaByAttribute) {
      const metaByAttribute = new Map<string, string | undefined>();

      for (const element of this.$("meta").toArray()) {
        const meta = this.$(element);

        for (const candidateAttribute of ["name", "property"] as const) {
          const candidateValue = meta.attr(candidateAttribute);

          if (candidateValue === undefined) {
            continue;
          }

          const key = `${candidateAttribute}\u0000${candidateValue}`;

          if (!metaByAttribute.has(key)) {
            metaByAttribute.set(key, meta.attr("content"));
          }
        }
      }

      this.#metaByAttribute = metaByAttribute;
    }

    return this.#metaByAttribute.get(`${attribute}\u0000${value}`);
  }

  /** `$("title").text()`, untrimmed (it includes inline SVG titles, exactly like before). */
  public get titleText(): string {
    this.#titleText ??= this.$("title").text();
    return this.#titleText;
  }

  /** `$("h1").first().text()`, untrimmed. */
  public get firstHeadingText(): string {
    this.#firstHeadingText ??= this.$("h1").first().text();
    return this.#firstHeadingText;
  }

  /** `$("body").text()` with whitespace collapsed. */
  public get bodyText(): string {
    this.#bodyText ??= this.$("body").text().replace(/\s+/g, " ").trim();
    return this.#bodyText;
  }
}

const parsedDocuments = new WeakMap<HtmlSourceDocument, ParsedHtmlDocument>();

export const parseHtmlDocument = (html: string): ParsedHtmlDocument => new ParsedHtmlDocument(html);

export const attachParsedHtmlDocument = (
  document: HtmlSourceDocument,
  parsed: ParsedHtmlDocument
): void => {
  if (parsed.html === document.html) {
    parsedDocuments.set(document, parsed);
  }
};

/**
 * Returns the shared parse for a fetched document (parsing it once on first
 * use), or parses a raw HTML string. Documents are keyed by identity, so a copy
 * with different HTML never reuses a stale parse.
 */
export const getParsedHtmlDocument = (
  source: HtmlSourceDocument | ParsedHtmlDocument | string
): ParsedHtmlDocument => {
  if (source instanceof ParsedHtmlDocument) {
    return source;
  }

  if (typeof source === "string") {
    return parseHtmlDocument(source);
  }

  const cached = parsedDocuments.get(source);

  if (cached && cached.html === source.html) {
    return cached;
  }

  const parsed = parseHtmlDocument(source.html);
  parsedDocuments.set(source, parsed);
  return parsed;
};

export const buildHtmlSourceDocument = ({
  url,
  finalUrl,
  html,
  contentType,
  blockedSignals,
  statusCode
}: {
  url: string;
  finalUrl: string;
  html: string;
  contentType: string | null;
  blockedSignals: string[];
  statusCode: number;
}): HtmlSourceDocument => {
  const parsed = parseHtmlDocument(html);
  const title =
    parsed.metaContent("property", "og:title")?.trim() ||
    parsed.metaContent("name", "twitter:title")?.trim() ||
    parsed.titleText.trim() ||
    null;
  const description =
    parsed.metaContent("property", "og:description")?.trim() ||
    parsed.metaContent("name", "description")?.trim() ||
    null;
  const document: HtmlSourceDocument = {
    kind: "html",
    url,
    finalUrl,
    html,
    contentType,
    title,
    description,
    blockedSignals,
    statusCode
  };

  attachParsedHtmlDocument(document, parsed);
  return document;
};
