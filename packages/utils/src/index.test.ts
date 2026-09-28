import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, defuseTagOpeners, toTrimmedOrNull } from "./index.js";

// String.prototype.isWellFormed is ES2024; this package targets ES2022, so detect lone
// surrogates directly.
const hasLoneSurrogate = (value: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

describe("toTrimmedOrNull", () => {
  it("returns null for blank strings", () => {
    expect(toTrimmedOrNull("   ")).toBeNull();
    expect(toTrimmedOrNull("")).toBeNull();
  });

  it("trims meaningful strings", () => {
    expect(toTrimmedOrNull("  olive oil ")).toBe("olive oil");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("salt &amp; pepper")).toBe("salt & pepper");
    expect(decodeHtmlEntities("&frac12; cup")).toBe("½ cup");
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });

  it("decodes numeric entities", () => {
    expect(decodeHtmlEntities("&#189; cup")).toBe("½ cup");
    expect(decodeHtmlEntities("&#x2013;")).toBe("–");
    expect(decodeHtmlEntities("&#128512;")).toBe("😀");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeHtmlEntities("&notanentity;")).toBe("&notanentity;");
    expect(decodeHtmlEntities("&#x110000;")).toBe("&#x110000;");
  });

  it("never emits lone surrogates", () => {
    for (const entity of ["&#xD800;", "&#xDFFF;", "&#55296;", "&#57343;"]) {
      const decoded = decodeHtmlEntities(`a${entity}b`);

      expect(hasLoneSurrogate(decoded)).toBe(false);
      expect(decoded).toBe(`a${entity}b`);
    }
  });

  it("keeps surrogate-pair code points that are well formed", () => {
    const decoded = decodeHtmlEntities("&#x1F600;");

    expect(hasLoneSurrogate(decoded)).toBe(false);
    expect(decoded).toBe("😀");
  });

  it("does not emit raw control characters", () => {
    // 0x81 and 0x9D are the C1 slots Windows-1252 leaves undefined, so HTML5 has no
    // character to map them to; they must stay encoded like any other control character.
    for (const entity of ["&#1;", "&#x1B;", "&#127;", "&#x81;", "&#x9D;", "&#x0B;"]) {
      const decoded = decodeHtmlEntities(`x${entity}y`);

      expect(decoded).toBe(`x${entity}y`);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(decoded)).toBe(false);
    }
  });

  it("still decodes whitespace control characters that are safe in text", () => {
    expect(decodeHtmlEntities("a&#10;b")).toBe("a\nb");
    expect(decodeHtmlEntities("a&#9;b")).toBe("a\tb");
    expect(decodeHtmlEntities("a&#13;b")).toBe("a\rb");
  });
});

describe("decodeHtmlEntities recipe vocabulary (bug 1)", () => {
  // Every entity here showed up raw in JSON-LD recipe text ("350&deg;F", "Grandma&rsquo;s").
  const namedEntityCorpus: ReadonlyArray<readonly [string, string]> = [
    ["Bake at 350&deg;F", "Bake at 350°F"],
    ["Grandma&rsquo;s Pie", "Grandma’s Pie"],
    ["&lsquo;quoted&rsquo;", "‘quoted’"],
    ["&ldquo;Best ever&rdquo; brownies", "“Best ever” brownies"],
    ["Saut&eacute;ed onions", "Sautéed onions"],
    ["Cr&egrave;me fra&icirc;che", "Crème fraîche"],
    ["1 jalape&ntilde;o", "1 jalapeño"],
    ["2 &times; 400g tins", "2 × 400g tins"],
    ["&frac12; cup", "½ cup"],
    ["&frac13; cup", "⅓ cup"],
    ["&frac14; cup", "¼ cup"],
    ["&frac34; cup", "¾ cup"],
    ["&frac18; tsp", "⅛ tsp"],
    ["&frac23; cup", "⅔ cup"],
    ["Stir&hellip;", "Stir…"],
    ["5&ndash;7 minutes", "5–7 minutes"],
    ["Rest&mdash;covered", "Rest—covered"],
    ["a&nbsp;b", "a b"],
    ["Cr&Egrave;ME", "CrÈME"],
    ["&Eacute;clair", "Éclair"],
    ["Fish &amp; Chips", "Fish & Chips"],
    ["Pi&ntilde;a Colada &copy; 2026", "Piña Colada © 2026"],
    ["Stra&szlig;e M&uuml;sli", "Straße Müsli"]
  ];

  it("decodes the named entities recipe sites use", () => {
    expect(namedEntityCorpus).toHaveLength(23);

    for (const [input, expected] of namedEntityCorpus) {
      expect(decodeHtmlEntities(input), input).toBe(expected);
    }
  });

  it("decodes numeric typographic quotes in decimal and hex", () => {
    expect(decodeHtmlEntities("Grandma&#8217;s")).toBe("Grandma’s");
    expect(decodeHtmlEntities("Grandma&#x2019;s")).toBe("Grandma’s");
    expect(decodeHtmlEntities("Grandma&#X2019;s")).toBe("Grandma’s");
    expect(decodeHtmlEntities("&#8220;hi&#8221;")).toBe("“hi”");
    expect(decodeHtmlEntities("350&#176;F")).toBe("350°F");
  });

  it("decodes legacy Windows-1252 references the way browsers do", () => {
    expect(decodeHtmlEntities("Grandma&#146;s")).toBe("Grandma’s");
    expect(decodeHtmlEntities("5&#150;7 minutes")).toBe("5–7 minutes");
    expect(decodeHtmlEntities("&#147;quoted&#148;")).toBe("“quoted”");
    expect(decodeHtmlEntities("wait&#133;")).toBe("wait…");
    expect(decodeHtmlEntities("&#x9F;")).toBe("Ÿ");
  });

  it("prefers the exact-case entity and falls back to lowercase", () => {
    expect(decodeHtmlEntities("&AMP;")).toBe("&");
    expect(decodeHtmlEntities("&Ntilde;")).toBe("Ñ");
    expect(decodeHtmlEntities("&NTILDE;")).toBe("ñ");
  });

  it("decodes once so a double-encoded entity keeps its literal text", () => {
    expect(decodeHtmlEntities("&amp;rsquo;")).toBe("&rsquo;");
  });
});

describe("defuseTagOpeners", () => {
  const TAG_OPENER = /<[!/?A-Za-z]/u;

  it("puts a space after each '<' that would open a tag, end tag, comment or declaration", () => {
    expect(defuseTagOpeners("<script>alert(1)")).toBe("< script>alert(1)");
    expect(defuseTagOpeners("Mix well</p")).toBe("Mix well< /p");
    expect(defuseTagOpeners("<!-- note")).toBe("< !-- note");
    expect(defuseTagOpeners("<?xml")).toBe("< ?xml");
    expect(defuseTagOpeners("<<script")).toBe("<< script");
  });

  it("keeps a real less-than sign in plain text, so the text keeps its meaning", () => {
    expect(defuseTagOpeners("Heat to <medium, then simmer")).toBe("Heat to < medium, then simmer");
    expect(defuseTagOpeners("if a<b then")).toBe("if a< b then");
    expect(defuseTagOpeners("I <3 it </3 when gone")).toBe("I <3 it < /3 when gone");
    expect(defuseTagOpeners("Jane Doe <jane@example.com>")).toBe("Jane Doe < jane@example.com>");
  });

  it("leaves '<' that HTML reads as text as it is", () => {
    for (const text of ["cook to < 165°F", "<3", "<- stir", "1 <= 2", "a < b > c", "x<", "<"]) {
      expect(defuseTagOpeners(text)).toBe(text);
    }
  });

  it("never leaves an opener and only ever adds a space after an opening '<'", () => {
    let seed = 11;
    const next = (): number => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const alphabet = ["<", "<", "a", "Z", "/", "!", "?", " ", "1", ">", "-"];

    for (let run = 0; run < 3_000; run += 1) {
      const input = Array.from(
        { length: Math.floor(next() * 16) },
        () => alphabet[Math.floor(next() * alphabet.length)] ?? ""
      ).join("");
      const output = defuseTagOpeners(input);
      const spaced = input
        .split("")
        .map((character, index) =>
          character === "<" && TAG_OPENER.test(input.slice(index, index + 2)) ? "< " : character
        )
        .join("");

      expect(TAG_OPENER.test(output), JSON.stringify(input)).toBe(false);
      expect(output, JSON.stringify(input)).toBe(spaced);
    }
  });

  it("runs in linear time on long runs of '<'", () => {
    const fastestMilliseconds = (input: string): number =>
      Math.min(
        ...[0, 1, 2].map(() => {
          const started = performance.now();
          defuseTagOpeners(input);
          return performance.now() - started;
        })
      );

    expect(defuseTagOpeners(`${"<".repeat(100_000)}a`)).toBe(`${"<".repeat(100_000)} a`);
    expect(defuseTagOpeners("<a".repeat(50_000))).toBe("< a".repeat(50_000));

    for (const input of [`${"<".repeat(100_000)}a`, "<a".repeat(50_000), "<".repeat(100_000)]) {
      expect(fastestMilliseconds(input)).toBeLessThan(50);
    }
  });
});
