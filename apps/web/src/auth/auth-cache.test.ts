import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_CONFIG_CACHE_KEY,
  AUTH_USER_CACHE_KEY,
  clearCachedAuthUser,
  clearClerkSignOutPending,
  CLERK_SIGN_OUT_PENDING_KEY,
  isCachedUserPremium,
  isClerkSignOutPending,
  markClerkSignOutPending,
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

  it("keeps a pending Clerk sign-out to the session it was made for", () => {
    expect(isClerkSignOutPending()).toBe(false);

    markClerkSignOutPending("sess_1");
    expect(isClerkSignOutPending("sess_1")).toBe(true);
    expect(isClerkSignOutPending("sess_2")).toBe(false);
    // Clerk's session isn't known yet: the sign-out still counts.
    expect(isClerkSignOutPending(null)).toBe(true);

    markClerkSignOutPending(null);
    expect(isClerkSignOutPending("sess_2")).toBe(true);

    // Earlier builds stored a bare timestamp, for whichever session Clerk had.
    localStorage.setItem(CLERK_SIGN_OUT_PENDING_KEY, "2026-09-28T00:00:00.000Z");
    expect(isClerkSignOutPending("sess_2")).toBe(true);

    clearClerkSignOutPending();
    expect(isClerkSignOutPending(null)).toBe(false);
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
