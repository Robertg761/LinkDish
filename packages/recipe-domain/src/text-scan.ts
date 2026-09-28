/**
 * Linear-time stand-ins for regular expressions that backtrack quadratically on hostile text.
 * Internal: index.ts does not re-export this module.
 *
 * A global pattern such as `\s*\([^)]*\)\s*` or an end-anchored one such as `[.:;,\s]+$` is
 * retried at every start position, and each retry rescans the rest of a long run ("((((…" with
 * no ")", "     …x", "……x"), so 40,000 pasted characters took most of a second. These scans
 * visit each character a bounded number of times and return exactly what the patterns they
 * replace returned. removeHtmlTags is the exception: it reads tags by its own rules, quoted
 * attribute values included, which a regex could only do with nested alternatives that come
 * with no such guarantee.
 */

const SPACE_CHARACTER = /\s/u;

const isSpace = (character: string | undefined): boolean =>
  character !== undefined && SPACE_CHARACTER.test(character);

/** An opening bracket and the character that closes it, such as ["(", ")"]. */
export type BracketPair = readonly [open: string, close: string];

/**
 * Replaces each bracketed group, together with the whitespace on both sides of it, the way a
 * global replace of `\s*(?:\([^)]*\)|\[[^\]]*\])\s*` does for the pairs "()" and "[]": a group
 * runs from an opening bracket to the first matching closer after it (other brackets inside
 * included), and an opening bracket that is never closed stays as text.
 */
export const replaceBracketedGroups = (
  text: string,
  pairs: readonly BracketPair[],
  replacement: string
): string => {
  const closers = new Map<string, string>(pairs);
  const unclosed = new Set<string>();
  const parts: string[] = [];
  let copied = 0;

  for (let index = 0; index < text.length; index += 1) {
    const open = text[index] ?? "";
    const close = closers.get(open);

    if (close === undefined || unclosed.has(open)) {
      continue;
    }

    const closeIndex = text.indexOf(close, index + 1);

    if (closeIndex === -1) {
      // No closer after this opener means none after any later one: never search again.
      unclosed.add(open);
      continue;
    }

    let start = index;
    while (start > copied && isSpace(text[start - 1])) {
      start -= 1;
    }

    let end = closeIndex + 1;
    while (end < text.length && isSpace(text[end])) {
      end += 1;
    }

    parts.push(text.slice(copied, start), replacement);
    copied = end;
    index = end - 1;
  }

  if (parts.length === 0) {
    return text;
  }

  parts.push(text.slice(copied));
  return parts.join("");
};

/**
 * `text` without its trailing run of characters matched by `character`, a one-character class
 * without the g or y flag: `trimEndMatching(text, /[.:;,\s]/u)` equals
 * `text.replace(/[.:;,\s]+$/u, "")`.
 */
export const trimEndMatching = (text: string, character: RegExp): string => {
  let end = text.length;

  while (end > 0 && character.test(text[end - 1] ?? "")) {
    end -= 1;
  }

  return end === text.length ? text : text.slice(0, end);
};

/** An ASCII letter, by UTF-16 code unit (NaN, past the end of the text, is none). */
const isLetterCode = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

/** A letter, a digit or "-": what may follow the first letter of a tag name. */
const isTagNameCode = (code: number): boolean =>
  isLetterCode(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d;

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const COLON = 0x3a;
const EXCLAMATION_MARK = 0x21;
const QUESTION_MARK = 0x3f;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

/**
 * Where the tag name starting at `index` ends: a letter, then letters, digits and "-", with one
 * optional namespace part ("o:p", as Word writes it). `index` itself when no name starts there.
 */
const tagNameEnd = (text: string, index: number): number => {
  if (!isLetterCode(text.charCodeAt(index))) {
    return index;
  }

  let end = index + 1;
  while (isTagNameCode(text.charCodeAt(end))) {
    end += 1;
  }

  if (text.charCodeAt(end) === COLON && isLetterCode(text.charCodeAt(end + 1))) {
    end += 2;
    while (isTagNameCode(text.charCodeAt(end))) {
      end += 1;
    }
  }

  return end;
};

/**
 * The index just past the tag that the "<" at `start` opens, or -1 when it opens none. A tag
 * is "<!" or "<?" (a comment, declaration or processing instruction) up to the next ">" with
 * no "<" before it, or "<" or "</" and a tag name followed by ">", or by whitespace or "/" and
 * then attributes up to the first ">" outside a quoted value. A "<" outside quotes or the end
 * of the text means there was no tag after all.
 */
const tagEnd = (text: string, start: number): number => {
  const marker = text.charCodeAt(start + 1);

  if (marker === EXCLAMATION_MARK || marker === QUESTION_MARK) {
    for (let index = start + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);

      if (code === GREATER_THAN) {
        return index + 1;
      }
      if (code === LESS_THAN) {
        return -1;
      }
    }
    return -1;
  }

  const nameStart = marker === SLASH ? start + 2 : start + 1;
  let index = tagNameEnd(text, nameStart);
  const after = text.charCodeAt(index);

  if (index === nameStart || (after !== GREATER_THAN && after !== SLASH && !isSpace(text[index]))) {
    return -1;
  }

  while (index < text.length) {
    const code = text.charCodeAt(index);

    if (code === GREATER_THAN) {
      return index + 1;
    }
    if (code === LESS_THAN) {
      return -1;
    }
    if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      const close = text.indexOf(text.charAt(index), index + 1);

      // A quote that nothing closes is a stray character, as in '<a href="x>'.
      index = close === -1 ? index + 1 : close + 1;
    } else {
      index += 1;
    }
  }

  return -1;
};

/**
 * `text` without its HTML tags: "<p>", "</li>", "<br />", "<o:p>", "<!-- note -->" and
 * '<img alt="Cook to < 165°F">' go, and a ">" or "<" inside a quoted attribute value stays part
 * of its tag. Text that merely has angle brackets stays: "cook to < 165°F, then > 5 min",
 * "<3", "<jane@example.com>" and "<boiling, stir if >" are not tags, because a tag name has to
 * be followed by ">", whitespace or "/".
 *
 * Linear, although a "<" that turns out not to open a tag is followed by a fresh attempt at the
 * next "<", even one inside a quote the failed attempt skipped. Among the attributes an attempt
 * is in one of three states (outside quotes, inside "…", inside '…'); each character maps the
 * three one-to-one (a quote swaps "outside" with "inside" its kind), except the last quote of
 * each kind, where "outside" and "inside" both go on outside. An attempt that started earlier
 * is inside quotes wherever a later one starts (else it would have stopped at that "<"; tag
 * names hold no quotes), so attempts that overlap are in different states, but for those two
 * merges, and only a handful of them ever read the same character.
 */
export const removeHtmlTags = (text: string): string => {
  const parts: string[] = [];
  let copied = 0;
  let index = text.indexOf("<");

  while (index !== -1) {
    const end = tagEnd(text, index);

    if (end === -1) {
      index = text.indexOf("<", index + 1);
    } else {
      parts.push(text.slice(copied, index));
      copied = end;
      index = text.indexOf("<", end);
    }
  }

  if (parts.length === 0) {
    return text;
  }

  parts.push(text.slice(copied));
  return parts.join("");
};
