import { describe, expect, it } from "vitest";

import { isPublicIpAddress, validatePublicSourceUrl } from "./source-url-safety";

import type { ResolveHostname } from "./source-url-safety";

const resolverFor =
  (entries: Array<{ address: string; family: number }>): ResolveHostname =>
  () =>
    Promise.resolve(entries);

const publicResolver = resolverFor([{ address: "93.184.216.34", family: 4 }]);

describe("validatePublicSourceUrl port handling", () => {
  it("rejects well-known non-HTTP ports", async () => {
    for (const port of [22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017]) {
      await expect(
        validatePublicSourceUrl(`http://example.com:${port}/recipe`, {
          resolveHostname: publicResolver
        })
      ).resolves.toEqual({
        reason: "blocked_port",
        safe: false
      });
    }
  });

  it("allows the default and common HTTP ports", async () => {
    for (const url of [
      "https://example.com/recipe",
      "http://example.com:80/recipe",
      "https://example.com:443/recipe",
      "http://example.com:8080/recipe",
      "https://example.com:8443/recipe"
    ]) {
      await expect(
        validatePublicSourceUrl(url, {
          resolveHostname: publicResolver
        })
      ).resolves.toEqual({
        safe: true
      });
    }
  });

  it("still reports private literals as private even on an odd port", async () => {
    await expect(validatePublicSourceUrl("http://127.0.0.1:3000/recipe")).resolves.toEqual({
      reason: "private_address",
      safe: false
    });
  });
});

describe("6to4 relay range", () => {
  it("treats 192.88.99.0/24 as non-public", () => {
    expect(isPublicIpAddress("192.88.99.1")).toBe(false);
    expect(isPublicIpAddress("192.88.99.255")).toBe(false);
    expect(isPublicIpAddress("192.88.100.1")).toBe(true);
  });

  it("rejects hostnames resolving into the 6to4 relay range", async () => {
    await expect(
      validatePublicSourceUrl("https://relay.example/recipe", {
        resolveHostname: resolverFor([{ address: "192.88.99.1", family: 4 }])
      })
    ).resolves.toEqual({
      reason: "private_address",
      safe: false
    });
  });
});
