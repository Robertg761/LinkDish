import { describe, it, expect, beforeEach } from "vitest";

import {
  getLegacySessionToken,
  setLegacySessionToken,
  removeLegacySessionToken
} from "./auth-storage";

describe("auth-storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("should return null when no token is present", () => {
    expect(getLegacySessionToken()).toBeNull();
  });

  it("should set and retrieve the legacy session token", () => {
    const testToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    setLegacySessionToken(testToken);
    expect(getLegacySessionToken()).toBe(testToken);
    expect(sessionStorage.getItem("linkdish:web:session-token:v1")).toBe(testToken);
    expect(localStorage.getItem("linkdish:web:session-token:v1")).toBeNull();
  });

  it("should remove the legacy session token", () => {
    const testToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    setLegacySessionToken(testToken);
    removeLegacySessionToken();
    expect(getLegacySessionToken()).toBeNull();
  });

  it("moves an existing persistent token into session storage", () => {
    localStorage.setItem("linkdish:web:session-token:v1", "legacy-token");

    expect(getLegacySessionToken()).toBe("legacy-token");
    expect(sessionStorage.getItem("linkdish:web:session-token:v1")).toBe("legacy-token");
    expect(localStorage.getItem("linkdish:web:session-token:v1")).toBeNull();
  });
});
