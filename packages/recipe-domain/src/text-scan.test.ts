import { describe, expect, it } from "vitest";

import { removeHtmlTags, replaceBracketedGroups, trimEndMatching } from "./text-scan.js";

/** Deterministic strings over `alphabet`, so a failure names a reproducible input. */
const seededStrings = (alphabet: readonly string[], count: number, maxLength: number) => {
  let seed = 20260928;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };

  return Array.from({ length: count }, () =>
    Array.from(
      { length: Math.floor(next() * (maxLength + 1)) },
      () => alphabet[Math.floor(next() * alphabet.length)] ?? ""
    ).join("")
  );
};

const HOSTILE = 100_000;

/** Fastest of three runs: a GC pause cannot fail the check, and quadratic work never is fast. */
const fastestMilliseconds = (run: () => unknown): number =>
  Math.min(
    ...[0, 1, 2].map(() => {
      const started = performance.now();
      run();
      return performance.now() - started;
    })
  );

describe("replaceBracketedGroups", () => {
  const parentheses = [["(", ")"]] as const;
  const notes = [
    ["(", ")"],
    ["[", "]"]
  ] as const;

  it("drops groups with the whitespace around them and leaves unclosed openers", () => {
    expect(replaceBracketedGroups("cookies (about 24) ", parentheses, " ")).toBe("cookies ");
    expect(replaceBracketedGroups("milk (skim, 1%) [cold], x", notes, " ")).toBe("milk  , x");
    expect(replaceBracketedGroups("a (b (c) d) e", parentheses, " ")).toBe("a d) e");
    expect(replaceBracketedGroups("a ( b", parentheses, " ")).toBe("a ( b");
    expect(replaceBracketedGroups("a [x (y] z)", notes, "|")).toBe("a|z)");
    expect(replaceBracketedGroups("no groups", notes, " ")).toBe("no groups");
  });

  it("returns exactly what the global regex it replaced returned", () => {
    const inputs = seededStrings([" ", "\t", "\u00a0", "(", ")", "[", "]", "a", ","], 4_000, 14);

    for (const input of inputs) {
      expect(replaceBracketedGroups(input, parentheses, " "), JSON.stringify(input)).toBe(
        input.replace(/\s*\([^)]*\)\s*/gu, " ")
      );
      expect(replaceBracketedGroups(input, notes, " "), JSON.stringify(input)).toBe(
        input.replace(/\s*(?:\([^)]*\)|\[[^\]]*\])\s*/gu, " ")
      );
    }
  });

  it("scans long runs of openers or spaces in linear time", () => {
    for (const input of ["(".repeat(HOSTILE), "[".repeat(HOSTILE), " ".repeat(HOSTILE) + "x"]) {
      expect(replaceBracketedGroups(input, notes, " ")).toBe(input);
      expect(fastestMilliseconds(() => replaceBracketedGroups(input, notes, " "))).toBeLessThan(50);
      expect(
        fastestMilliseconds(() => replaceBracketedGroups(input, notes, " ", { keepSpaces: true }))
      ).toBeLessThan(50);
    }
  });

  it("with keepSpaces, returns exactly what the space-keeping global regex returned", () => {
    const inputs = seededStrings([" ", "\t", " ", "(", ")", "[", "]", "a", ","], 4_000, 14);

    expect(replaceBracketedGroups("green (spring) onions", notes, " ", { keepSpaces: true })).toBe(
      "green   onions"
    );

    for (const input of inputs) {
      expect(
        replaceBracketedGroups(input, notes, " ", { keepSpaces: true }),
        JSON.stringify(input)
      ).toBe(input.replace(/\([^)]*\)|\[[^\]]*\]/gu, " "));
    }
  });
});

describe("trimEndMatching", () => {
  it("returns exactly what the end-anchored regex it replaced returned", () => {
    const inputs = seededStrings([" ", "\n", ".", ":", ";", ",", "*", "†", "/", "a"], 4_000, 12);

    for (const input of inputs) {
      expect(trimEndMatching(input, /[.:;,\s]/u), JSON.stringify(input)).toBe(
        input.replace(/[.:;,\s]+$/u, "")
      );
      expect(trimEndMatching(input, /[\s*†‡.:]/u), JSON.stringify(input)).toBe(
        input.replace(/[\s*†‡.:]+$/u, "")
      );
      expect(trimEndMatching(input, /\//u), JSON.stringify(input)).toBe(input.replace(/\/+$/u, ""));
    }
  });

  it("trims in linear time when a long run is not at the end", () => {
    const input = `cookies${".".repeat(HOSTILE)}x`;
    const padded = `${input}${". ".repeat(HOSTILE)}`;

    expect(trimEndMatching(input, /[.:;,\s]/u)).toBe(input);
    expect(trimEndMatching(padded, /[.:;,\s]/u)).toBe(input);
    expect(fastestMilliseconds(() => trimEndMatching(input, /[.:;,\s]/u))).toBeLessThan(50);
    expect(fastestMilliseconds(() => trimEndMatching(padded, /[.:;,\s]/u))).toBeLessThan(50);
  });
});

describe("removeHtmlTags", () => {
  /*
   * The same tags as a regex, for short inputs only: a quote that nothing closes is found with a
   * lookahead over the rest of the text. Its matches are cut out with matchAll, so the oracle is
   * not itself a tag-stripping replace.
   */
  const TAG_ORACLE =
    /<(?:[!?][^<>]*>|\/?[A-Za-z][A-Za-z0-9-]*(?::[A-Za-z][A-Za-z0-9-]*)?(?:[\s/](?:[^<>"']|"[^"]*"|'[^']*'|"(?![^"]*")|'(?![^']*'))*)?>)/gu;
  const oracle = (text: string): string => {
    let kept = "";
    let copied = 0;

    for (const match of text.matchAll(TAG_ORACLE)) {
      kept += text.slice(copied, match.index);
      copied = match.index + match[0].length;
    }

    return kept + text.slice(copied);
  };

  it("drops tags, comments and declarations, quoted '<' and '>' included", () => {
    expect(removeHtmlTags("<p>Mix</p><br /><BR/><P CLASS=x>well</p >")).toBe("Mixwell");
    expect(removeHtmlTags('<img src="a.jpg" alt="Cook to < 165°F">Cook')).toBe("Cook");
    expect(removeHtmlTags("<span title='<3'>love</span> it")).toBe("love it");
    expect(removeHtmlTags(`<img alt='a > b' title="it's">after`)).toBe("after");
    expect(removeHtmlTags("<o:p></o:p>Word<!-- note --><!DOCTYPE html><?xml v?>")).toBe("Word");
    expect(removeHtmlTags("<p\nclass=x>a<a/b>c")).toBe("ac");
    expect(removeHtmlTags("<a href=\"x>Link</a> it's")).toBe("Link it's");
  });

  it("keeps text that only has angle brackets", () => {
    for (const text of [
      "Cook to < 165°F, then rest > 5 min",
      "I <3 it </3",
      "Jane Doe <jane@example.com>",
      "See <https://example.com/recipe>",
      "<Optional: garnish>",
      "Keep temp <boiling, stir if > 5 min",
      "Mix well <script src=x",
      '<a title="unclosed',
      "<>, </>, <-, <<"
    ]) {
      expect(removeHtmlTags(text)).toBe(text);
    }
  });

  it("drops exactly the tags that the equivalent regex matches", () => {
    const inputs = seededStrings(
      ["<", "<", "</", ">", "a", "b", "1", ":", "-", " ", "\n", "/", "!", "?", '"', "'", "="],
      8_000,
      18
    );

    for (const input of inputs) {
      expect(removeHtmlTags(input), JSON.stringify(input)).toBe(oracle(input));
    }
  });

  it("scans in linear time, however the quotes pair up from each '<'", () => {
    const fit = (unit: string): string => unit.repeat(Math.ceil(HOSTILE / unit.length));
    const inputs = [
      "<".repeat(HOSTILE),
      fit("<a"),
      fit("<a "),
      `<a "${fit("<a ")}`,
      fit(`<a "<a '`),
      fit(`<a"<a '"`),
      fit(`<b/":a'`),
      `${fit(`<a "<a '`)}"'`,
      fit("<!<?")
    ];

    for (const input of inputs) {
      expect(fastestMilliseconds(() => removeHtmlTags(input))).toBeLessThan(50);
    }
  });
});
