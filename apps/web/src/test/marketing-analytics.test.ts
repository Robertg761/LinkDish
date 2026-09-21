import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `site/analytics.js` is a plain IIFE loaded by the marketing site. It talks to
 * `window.localStorage` directly, which throws in a storage-blocked browser, so
 * it is exercised here against fake globals.
 */
const analyticsSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../site/analytics.js"),
  "utf8"
);

interface FakeWindow {
  crypto: { randomUUID: () => string };
  localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
  location: { hostname: string; pathname: string; search: string };
}

const runAnalytics = (fakeWindow: FakeWindow) => {
  const sendBeacon = vi.fn(() => true);
  const fakeDocument = { addEventListener: vi.fn(), referrer: "" };
  const fakeNavigator = { sendBeacon };
  const fakeFetch = vi.fn(() => Promise.resolve());

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("window", "document", "navigator", "fetch", analyticsSource) as (
    windowArg: unknown,
    documentArg: unknown,
    navigatorArg: unknown,
    fetchArg: unknown
  ) => void;

  run(fakeWindow, fakeDocument, fakeNavigator, fakeFetch);

  return { fakeDocument, sendBeacon };
};

const createWindow = (storage: FakeWindow["localStorage"]): FakeWindow => ({
  crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
  localStorage: storage,
  location: { hostname: "linkdish.ca", pathname: "/", search: "" }
});

const workingStorage = () => {
  const store = new Map<string, string>();

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    }
  };
};

const blockedStorage = () => ({
  getItem: () => {
    throw new DOMException("Access denied.", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  }
});

describe("marketing site analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a page view when storage works", () => {
    const { sendBeacon, fakeDocument } = runAnalytics(createWindow(workingStorage()));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fakeDocument.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("still sends a page view when localStorage is blocked", () => {
    const { sendBeacon } = runAnalytics(createWindow(blockedStorage()));

    expect(sendBeacon).toHaveBeenCalledTimes(1);

    const [, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    expect(blob).toBeInstanceOf(Blob);
  });

  it("does nothing on localhost", () => {
    const localWindow = createWindow(workingStorage());
    localWindow.location.hostname = "localhost";

    const { sendBeacon } = runAnalytics(localWindow);

    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
