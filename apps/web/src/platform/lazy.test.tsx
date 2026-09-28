import { fireEvent, render, screen } from "@testing-library/react";
import React, { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackWebError } from "../analytics/client";
import { ErrorBoundary } from "../components/ErrorBoundary";

import {
  CHUNK_RELOAD_GUARD_MS,
  CHUNK_RELOAD_STORAGE_KEY,
  importWithRetry,
  installChunkErrorRecovery,
  isChunkLoadError,
  lazyWithRetry,
  reloadOnceForChunkError
} from "./lazy";

vi.mock("../analytics/client", () => ({
  trackWebError: vi.fn()
}));

const chunkError = () =>
  new TypeError("Failed to fetch dynamically imported module: https://app/assets/Page-abc.js");

describe("chunk error detection", () => {
  it("recognizes the errors browsers and Vite raise for missing chunks", () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
    expect(isChunkLoadError({ message: "x", name: "ChunkLoadError" })).toBe(true);
    expect(isChunkLoadError(new Error("render exploded"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("reloadOnceForChunkError", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("reloads once, then lets the error surface inside the guard window", () => {
    const reload = vi.fn();
    const now = 1_000_000;

    expect(reloadOnceForChunkError(reload, now)).toBe(true);
    expect(sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY)).toBe(String(now));
    expect(reloadOnceForChunkError(reload, now + 1000)).toBe(false);
    expect(reloadOnceForChunkError(reload, now + CHUNK_RELOAD_GUARD_MS + 1)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when the guard cannot be stored", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const reload = vi.fn();

    expect(reloadOnceForChunkError(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("handles vite:preloadError by reloading once", () => {
    const reload = vi.fn();
    installChunkErrorRecovery(reload);

    const first = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(first);
    const second = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(second);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(false);
  });
});

describe("importWithRetry", () => {
  it("retries a failing import before giving up", async () => {
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValueOnce("module");

    await expect(importWithRetry(factory, { retries: 2, retryDelayMs: 1 })).resolves.toBe("module");
    expect(factory).toHaveBeenCalledTimes(2);

    const failing = vi.fn(() => Promise.reject(chunkError()));
    await expect(importWithRetry(failing, { retries: 1, retryDelayMs: 1 })).rejects.toThrow(
      "dynamically imported module"
    );
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("lazyWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets the error boundary's Try again re-import a chunk that failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Page: React.FC<{ name: string }> = ({ name }) => <p>Hello {name}</p>;
    let available = false;
    const factory = vi.fn(() =>
      available ? Promise.resolve({ default: Page }) : Promise.reject(chunkError())
    );
    const LazyPage = lazyWithRetry(factory, { retries: 0 });

    render(
      <ErrorBoundary>
        <Suspense fallback={<p>Loading</p>}>
          <LazyPage name="cook" />
        </Suspense>
      </ErrorBoundary>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(trackWebError).toHaveBeenCalledWith(expect.any(TypeError), "/", "error_boundary");

    available = true;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText("Hello cook")).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("exposes preload", async () => {
    const Page: React.FC = () => <p>Preloaded</p>;
    const factory = vi.fn(() => Promise.resolve({ default: Page }));
    const LazyPage = lazyWithRetry(factory);

    await LazyPage.preload();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("renders a preloaded page on the first render, without a Suspense fallback", async () => {
    const Page: React.FC<{ name: string }> = ({ name }) => <p>Hello {name}</p>;
    const LazyPage = lazyWithRetry(() => Promise.resolve({ default: Page }));

    await LazyPage.preload();
    render(
      <Suspense fallback={<p>Loading</p>}>
        <LazyPage name="cook" />
      </Suspense>
    );

    // Synchronously there: no fallback frame, no extra render pass.
    expect(screen.getByText("Hello cook")).toBeInTheDocument();
    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
  });

  it("still suspends when the page was not preloaded", async () => {
    const Page: React.FC = () => <p>Loaded later</p>;
    const LazyPage = lazyWithRetry(() => Promise.resolve({ default: Page }));

    render(
      <Suspense fallback={<p>Loading</p>}>
        <LazyPage />
      </Suspense>
    );

    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(await screen.findByText("Loaded later")).toBeInTheDocument();
  });
});
