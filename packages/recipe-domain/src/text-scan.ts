/**
 * Linear-time stand-ins for regular expressions that backtrack quadratically on hostile text.
 * Internal: index.ts does not re-export this module.
 *
 * A global pattern such as `\s*\([^)]*\)\s*` or an end-anchored one such as `[.:;,\s]+$` is
 * retried at every start position, and each retry rescans the rest of a long run ("((((…" with
 * no ")", "     …x", "……x"), so 40,000 pasted characters took most of a second. These scans
 * visit each character a bounded number of times and return exactly what the patterns they
 * replace returned.
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
