import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, toTrimmedOrNull } from "./index.js";

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
