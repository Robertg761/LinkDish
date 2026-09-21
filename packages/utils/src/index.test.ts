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
    for (const entity of ["&#1;", "&#x1B;", "&#127;", "&#x9F;", "&#x0B;"]) {
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
