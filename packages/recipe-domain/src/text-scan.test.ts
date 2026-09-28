import { describe, expect, it } from "vitest";

import { replaceBracketedGroups, trimEndMatching } from "./text-scan.js";

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
