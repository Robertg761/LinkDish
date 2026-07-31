import { describe, expect, it } from "vitest";

import { isPublicIpAddress, validatePublicSourceUrl } from "./source-url-safety";

import type { ResolveHostname } from "./source-url-safety";

const resolverFor =
  (entries: Array<{ address: string; family: number }>): ResolveHostname =>
  () =>
    Promise.resolve(entries);

describe("validatePublicSourceUrl", () => {
  it("allows public HTTP and HTTPS hosts after DNS resolution", async () => {
    await expect(
      validatePublicSourceUrl("https://example.com/recipe", {
        resolveHostname: resolverFor([{ address: "93.184.216.34", family: 4 }])
      })
    ).resolves.toEqual({
      safe: true
    });
  });

  it("rejects unsupported protocols before fetch", async () => {
    await expect(validatePublicSourceUrl("file:///etc/passwd")).resolves.toEqual({
      reason: "unsupported_protocol",
      safe: false
    });
  });

  it("rejects localhost and private IP literals", async () => {
    await expect(validatePublicSourceUrl("https://localhost/recipe")).resolves.toEqual({
      reason: "blocked_hostname",
      safe: false
    });
    await expect(validatePublicSourceUrl("http://127.0.0.1:3000/recipe")).resolves.toEqual({
      reason: "private_address",
      safe: false
    });
  });

  it("rejects hostnames that resolve to private or metadata addresses", async () => {
    await expect(
      validatePublicSourceUrl("https://metadata.example/recipe", {
        resolveHostname: resolverFor([{ address: "169.254.169.254", family: 4 }])
      })
    ).resolves.toEqual({
      reason: "private_address",
      safe: false
    });
  });
});

describe("isPublicIpAddress", () => {
  it("blocks private IPv4 and IPv6 ranges", () => {
    expect(isPublicIpAddress("10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("172.16.0.1")).toBe(false);
    expect(isPublicIpAddress("192.168.0.1")).toBe(false);
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("fe80::1")).toBe(false);
    expect(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });
});
