import { ExtractorApiError } from "@linkdish/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  getFriendlyErrorMessage,
  getServerErrorMessage,
  isNetworkError,
  isOffline,
  isTimeoutError
} from "./error-message";
import {
  ExtractorApiError as WebExtractorApiError,
  getApiErrorKind,
  toWebApiError
} from "./errors";

const apiError = (status: number, details?: unknown) =>
  new ExtractorApiError("Extractor API request failed.", status, details);

const goOffline = () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
};

describe("getFriendlyErrorMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the server's own message when it is written for people", () => {
    expect(
      getFriendlyErrorMessage(
        apiError(429, { message: "Too many extract requests. Please try again shortly." }),
        "extract"
      )
    ).toBe("Too many extract requests. Please try again shortly.");
    expect(
      getFriendlyErrorMessage(apiError(403, { error: { message: "Invites expire after 7 days." } }))
    ).toBe("Invites expire after 7 days.");
  });

  it("never shows developer wording, JSON or status codes", () => {
    const messages = [
      getFriendlyErrorMessage(apiError(400, { message: "Invalid extract request." }), "extract"),
      getFriendlyErrorMessage(apiError(400, { message: '{"issues":[{"code":"too_small"}]}' })),
      getFriendlyErrorMessage(apiError(500, { message: "Unexpected extractor error." })),
      getFriendlyErrorMessage(apiError(400, "<html>Bad gateway</html>")),
      getFriendlyErrorMessage(
        new ExtractorApiError("Extractor API response did not match the contract.", 200, {})
      )
    ];

    expect(messages).toEqual([
      "We couldn't read a recipe from that. Try another link, or paste the recipe text.",
      "Something went wrong. Please try again.",
      "LinkDish is having trouble right now. Please try again shortly.",
      "Something went wrong. Please try again.",
      "We got an answer we didn't expect. Please try again."
    ]);
    for (const message of messages) {
      expect(message).not.toMatch(/[{}]|\b\d{3}\b|contract|extractor/iu);
    }
  });

  it("maps status codes to plain language for the situation", () => {
    expect(getFriendlyErrorMessage(apiError(401), "load")).toBe(
      "Please sign in again to continue."
    );
    expect(
      getFriendlyErrorMessage(apiError(401, { message: "Session expired for you" }), "auth")
    ).toBe("That sign-in didn't work. Please try again.");
    expect(getFriendlyErrorMessage(apiError(403), "household")).toBe(
      "This needs an active Family household."
    );
    expect(getFriendlyErrorMessage(apiError(404), "share")).toBe(
      "That shared recipe is no longer available."
    );
    expect(getFriendlyErrorMessage(apiError(413), "extract")).toMatch(/too large to import/u);
    expect(getFriendlyErrorMessage(apiError(503), "sync")).toBe(
      "LinkDish is having trouble right now. Please try again shortly."
    );
  });

  it("explains timeouts, dropped connections and offline mode", () => {
    expect(getFriendlyErrorMessage(new DOMException("signal timed out", "TimeoutError"))).toBe(
      "That took too long to answer. Please try again in a moment."
    );
    expect(getFriendlyErrorMessage(new DOMException("aborted", "AbortError"))).toMatch(/too long/u);
    expect(getFriendlyErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "We couldn't reach LinkDish. Check your connection and try again."
    );

    goOffline();
    expect(isOffline()).toBe(true);
    expect(getFriendlyErrorMessage(apiError(500))).toBe(
      "You're offline. Check your connection and try again."
    );
  });

  it("hides validation errors", () => {
    const result = z.object({ url: z.string().url() }).safeParse({ url: "nope" });
    const zodError = result.success ? null : result.error;

    expect(getFriendlyErrorMessage(zodError, "extract")).toBe(
      "Some details didn't look right. Check them and try again."
    );
    expect(getFriendlyErrorMessage(zodError, "load")).toBe(
      "We got an answer we didn't expect. Please try again."
    );
  });

  it("falls back to calm context copy for anything else", () => {
    expect(getFriendlyErrorMessage(new Error("kaboom"), "save")).toBe(
      "We couldn't save that. Please try again."
    );
    expect(getFriendlyErrorMessage("weird")).toBe("Something went wrong. Please try again.");
  });
});

describe("error classification helpers", () => {
  it("classifies errors", () => {
    expect(isTimeoutError(new Error("Extractor API request timed out."))).toBe(true);
    expect(isTimeoutError(new Error("nope"))).toBe(false);
    expect(isNetworkError(new TypeError("NetworkError when attempting to fetch resource."))).toBe(
      true
    );
    expect(isNetworkError(new TypeError("Load failed"))).toBe(true);
    expect(isNetworkError(new TypeError("x is not a function"))).toBe(false);
    expect(getServerErrorMessage(new Error("plain"))).toBeNull();
    expect(getServerErrorMessage(apiError(400, { message: "  Please   add a link.  " }))).toBe(
      "Please add a link."
    );
  });
});

describe("getFriendlyErrorMessage with api-client v2 error kinds", () => {
  it("uses connection copy for network and timeout kinds instead of the raw message", () => {
    const network = new ExtractorApiError("Failed to fetch", 0, undefined, { kind: "network" });
    const timeout = new ExtractorApiError("Request timed out", 0, undefined, { kind: "timeout" });

    expect(getFriendlyErrorMessage(network, "extract")).toMatch(/couldn't reach LinkDish/);
    expect(getFriendlyErrorMessage(timeout, "extract")).toMatch(/took too long/);
  });

  it("keeps the kind when converting the package error class", () => {
    const packageError = Object.assign(new Error("Failed to fetch"), {
      name: "ExtractorApiError",
      statusCode: 0,
      kind: "network",
      serverMessage: undefined
    });
    const converted = toWebApiError(packageError);

    expect(converted).toBeInstanceOf(WebExtractorApiError);
    expect(getApiErrorKind(converted)).toBe("network");
    expect(getFriendlyErrorMessage(converted)).toMatch(/couldn't reach LinkDish/);
  });
});
