import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_CONFIG_CACHE_KEY,
  AUTH_USER_CACHE_KEY,
  clearCachedAuthUser,
  isCachedUserPremium,
  readCachedAuthConfig,
  readCachedAuthUser,
  writeCachedAuthConfig,
  writeCachedAuthUser
} from "./auth-cache";

describe("auth cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the auth config and user", () => {
    writeCachedAuthConfig({ authMode: "clerk_beta", clerkEnabled: true, emailCodeEnabled: true });
    writeCachedAuthUser({ billingPlan: "family", email: "cook@example.com", id: "u1" }, "clerk");

    expect(readCachedAuthConfig()?.config).toEqual({
      authMode: "clerk_beta",
      clerkEnabled: true,
      emailCodeEnabled: true
    });
    expect(readCachedAuthUser()).toMatchObject({
      source: "clerk",
      user: { billingPlan: "family", email: "cook@example.com", id: "u1" }
    });
    expect(isCachedUserPremium()).toBe(true);

    clearCachedAuthUser();
    expect(readCachedAuthUser()).toBeNull();
    expect(isCachedUserPremium()).toBe(false);
  });

  it("ignores corrupt or tampered entries", () => {
    localStorage.setItem(AUTH_CONFIG_CACHE_KEY, "{not json");
    localStorage.setItem(
      AUTH_USER_CACHE_KEY,
      JSON.stringify({ savedAt: "2026-09-01", source: "carrier-pigeon", user: { id: "u1" } })
    );

    expect(readCachedAuthConfig()).toBeNull();
    expect(readCachedAuthUser()).toBeNull();

    localStorage.setItem(
      AUTH_CONFIG_CACHE_KEY,
      JSON.stringify({ config: { authMode: "magic" }, savedAt: "2026-09-01" })
    );
    expect(readCachedAuthConfig()).toBeNull();
  });

  it("survives blocked storage", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(readCachedAuthUser()).toBeNull();
    expect(() =>
      writeCachedAuthUser({ email: "cook@example.com", id: "u1" }, "legacy")
    ).not.toThrow();
    vi.restoreAllMocks();
  });
});
