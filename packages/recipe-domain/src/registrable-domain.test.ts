import { describe, expect, it } from "vitest";

import {
  getRegistrableDomain,
  isSameRegistrableDomain,
  normalizeSiteHostname
} from "./registrable-domain.js";

describe("getRegistrableDomain", () => {
  it("finds the site below the public suffix", () => {
    expect(getRegistrableDomain("www.allrecipes.com")).toBe("allrecipes.com");
    expect(getRegistrableDomain("recipes.example.co.uk")).toBe("example.co.uk");
    expect(getRegistrableDomain("cook.wordpress.com")).toBe("cook.wordpress.com");
    expect(getRegistrableDomain("10.0.0.1")).toBe("10.0.0.1");
    expect(getRegistrableDomain("[::1]")).toBe("[::1]");
  });

  it("tells one site from another", () => {
    expect(isSameRegistrableDomain("www.allrecipes.com", "allrecipes.com")).toBe(true);
    expect(isSameRegistrableDomain("recipes.example.co.uk", "unrelated.co.uk")).toBe(false);
    expect(isSameRegistrableDomain("a.wordpress.com", "b.wordpress.com")).toBe(false);
  });
});

describe("normalizeSiteHostname", () => {
  it("trims trailing dots quickly, even a long run of them", () => {
    expect(normalizeSiteHostname(" Example.COM.. ")).toBe("example.com");
    const started = Date.now();
    expect(normalizeSiteHostname(`a${".".repeat(100_000)}b`)).toHaveLength(100_002);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
