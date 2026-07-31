import { describe, expect, it, vi, afterEach } from "vitest";

import { isOnline, addNetworkListeners } from "./detect-network";

describe("detect-network", () => {
  describe("isOnline", () => {
    it("returns true when navigator.onLine is true", () => {
      Object.defineProperty(navigator, "onLine", {
        value: true,
        writable: true,
        configurable: true
      });
      expect(isOnline()).toBe(true);
    });

    it("returns false when navigator.onLine is false", () => {
      Object.defineProperty(navigator, "onLine", {
        value: false,
        writable: true,
        configurable: true
      });
      expect(isOnline()).toBe(false);
    });
  });

  describe("addNetworkListeners", () => {
    let cleanup: (() => void) | null = null;

    afterEach(() => {
      cleanup?.();
      cleanup = null;
    });

    it("calls onOffline when offline event fires", () => {
      const onOffline = vi.fn();
      const onOnline = vi.fn();
      cleanup = addNetworkListeners({ onOffline, onOnline });

      window.dispatchEvent(new Event("offline"));
      expect(onOffline).toHaveBeenCalledTimes(1);
      expect(onOnline).not.toHaveBeenCalled();
    });

    it("calls onOnline when online event fires", () => {
      const onOffline = vi.fn();
      const onOnline = vi.fn();
      cleanup = addNetworkListeners({ onOffline, onOnline });

      window.dispatchEvent(new Event("online"));
      expect(onOnline).toHaveBeenCalledTimes(1);
      expect(onOffline).not.toHaveBeenCalled();
    });

    it("removes listeners on cleanup", () => {
      const onOffline = vi.fn();
      const onOnline = vi.fn();
      cleanup = addNetworkListeners({ onOffline, onOnline });
      cleanup();

      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      expect(onOffline).not.toHaveBeenCalled();
      expect(onOnline).not.toHaveBeenCalled();
    });
  });
});
