import { render, screen, waitFor } from "@testing-library/react";
import React, { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

import { lazyWithRetry } from "./lazy";
import { OptionalChunkBoundary } from "./OptionalChunkBoundary";

vi.mock("../analytics/client", () => ({
  trackWebError: vi.fn()
}));

describe("OptionalChunkBoundary", () => {
  it("renders nothing (instead of crashing the app) when an optional chunk fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onError = vi.fn();
    const Broken = lazyWithRetry<React.FC>(
      () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
      { retries: 0 }
    );

    render(
      <main>
        <p>Cookbook</p>
        <OptionalChunkBoundary name="Sheet" onError={onError}>
          <Suspense fallback={null}>
            <Broken />
          </Suspense>
        </OptionalChunkBoundary>
      </main>
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Cookbook")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
