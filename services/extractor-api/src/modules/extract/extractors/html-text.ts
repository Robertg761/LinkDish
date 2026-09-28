import {
  decodeHtmlEntities,
  removeTagOpeners
} from "../../../../../../packages/utils/src/index.js";

/*
 * JSON-LD strings are supposed to be plain text, but plenty of sites put markup in them
 * ("<p>Mix &amp; bake</p>", "<ol><li>…</li></ol>", "Step one<br>Step two"). These helpers turn
 * such a fragment into readable text: block-level tags become line breaks (so a list or a
 * <br>-separated instruction block still splits into steps), other tags are dropped with their
 * text kept, and entities are decoded.
 *
 * The patterns only match things shaped like tags ("<" followed by a letter or "/"), so text
 * such as "cook to < 165°F" is left alone, and they scan linearly.
 *
 * Removing one tag can join the text around it into another ("<scr<b>ipt>" → "<script>"), so
 * stripping repeats while a pass still finds tags — a few passes at most, which keeps the work
 * linear on deliberately nested input — and removeTagOpeners then drops any "<" that could still
 * open markup (an unclosed "<script", or nesting deeper than the pass limit). Whatever the
 * input, the output has no "<" that a browser would read as the start of a tag.
 */

/*
 * After the tag name: attributes (whitespace, then anything but angle brackets), or a "/" and
 * optional whitespace, then ">". The same tags as `(?:\s[^<>]*)?\/?\s*>`, whose `[^<>]*` and
 * `\s*` could split one run of spaces many ways ("<br" + 40,000 spaces took a second).
 */
const blockBoundaryTagPattern =
  /<\s*(?:br|\/?p|\/?div|\/?li|\/?ul|\/?ol|\/?h[1-6]|\/?tr|\/?section|\/?article|\/?blockquote)(?:\s[^<>]*|\/\s*)?>/giu;
const anyTagPattern = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/giu;
const hasMarkupPattern = /[<&]/u;
const inlineWhitespacePattern = /[^\S\n]+/gu;
const newlineRunPattern = /\s*\n\s*/gu;
const MAX_TAG_STRIP_PASSES = 4;

/* indexOf scanning instead of a lazy /<!--[\s\S]*?-->/ that goes quadratic on unclosed comments. */
const stripComments = (value: string): string => {
  let index = value.indexOf("<!--");

  if (index === -1) {
    return value;
  }

  const parts: string[] = [];
  let cursor = 0;

  while (index !== -1) {
    parts.push(value.slice(cursor, index), " ");
    const end = value.indexOf("-->", index + 4);
    cursor = end === -1 ? value.length : end + 3;
    index = end === -1 ? -1 : value.indexOf("<!--", cursor);
  }

  parts.push(value.slice(cursor));
  return parts.join("");
};

const stripTags = (value: string): string => {
  let text = stripComments(value).replace(blockBoundaryTagPattern, "\n");

  for (let pass = 0; pass < MAX_TAG_STRIP_PASSES; pass += 1) {
    const stripped = text.replace(anyTagPattern, "");

    if (stripped === text) {
      break;
    }

    text = stripped;
  }

  return text;
};

/**
 * Readable text for a JSON-LD string. `preserveLines` keeps line breaks (for ingredient and
 * instruction blocks that are split into lines afterwards); otherwise all whitespace collapses
 * to single spaces.
 */
export const htmlFragmentToText = (
  value: string,
  options: { preserveLines?: boolean } = {}
): string => {
  let text = value.replace(/\r\n?/gu, "\n");

  if (hasMarkupPattern.test(text)) {
    // Stripped, decoded, then stripped again: some sites entity-encode their markup
    // ("&lt;p&gt;Mix&lt;/p&gt;"), which only becomes a tag after decoding.
    text = removeTagOpeners(stripTags(decodeHtmlEntities(stripTags(text))));
  }

  text = text.replace(/\u00a0/gu, " ");

  if (!options.preserveLines) {
    return text.replace(/\s+/gu, " ").trim();
  }

  return text.replace(inlineWhitespacePattern, " ").replace(newlineRunPattern, "\n").trim();
};

/** Non-empty lines of a text block (markup and entities handled as in {@link htmlFragmentToText}). */
export const htmlFragmentToLines = (value: string): string[] =>
  htmlFragmentToText(value, { preserveLines: true })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
