import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

  describe("when storage refuses writes", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const blockWrites = () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      });
    };

    it("does not throw when setting the legacy session token", () => {
      blockWrites();

      expect(() => {
        setLegacySessionToken("token-value");
      }).not.toThrow();
    });

    it("does not throw when migrating a persistent token", () => {
      localStorage.setItem("linkdish:web:session-token:v1", "legacy-token");
      blockWrites();

      expect(() => getLegacySessionToken()).not.toThrow();
      expect(getLegacySessionToken()).toBe("legacy-token");
    });

    it("does not throw when removing the legacy session token", () => {
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new DOMException("Denied.", "SecurityError");
      });

      expect(() => {
        removeLegacySessionToken();
      }).not.toThrow();
    });
  });
});
