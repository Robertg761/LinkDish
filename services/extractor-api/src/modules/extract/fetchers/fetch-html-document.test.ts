import { describe, expect, it, vi } from "vitest";

import { fetchHtmlDocument } from "./fetch-html-document";
import { detectBlockedSignals } from "./shared";

import type { ValidateSourceUrl } from "../source-url-safety";

const createHtmlResponse = (status: number, html: string, url = "https://example.com/final") =>
  ({
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({
      "content-type": "text/html"
    }),
    text: () => Promise.resolve(html)
  }) as Response;
const allowUrl: ValidateSourceUrl = () => Promise.resolve({ safe: true });

describe("fetchHtmlDocument", () => {
  it("classifies 402 anti-bot pages as blocked", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(
        createHtmlResponse(
          402,
          "<html><title>Access denied</title><body>Access denied</body></html>"
        )
      ) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/recipe", fetchImplementation, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 0
      })
    ).rejects.toMatchObject({
      reason: "blocked",
      statusCode: 402
    });
  });

  it("classifies 404 pages as not_found without retrying", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(
        createHtmlResponse(404, "<html><title>Page not found</title><body>404</body></html>")
      ) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/missing", fetchImplementation, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 2
      })
    ).rejects.toMatchObject({
      reason: "not_found",
      statusCode: 404
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("classifies aborts as timeouts", async () => {
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    const fetchImplementation = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/slow", fetchImplementation, {
        validateUrl: allowUrl,
        timeoutMs: 1,
        retries: 0
      })
    ).rejects.toMatchObject({
      reason: "timeout"
    });
  });

  it("rejects unsafe redirects before following them", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      url: "https://example.com/recipe",
      headers: new Headers({
        location: "http://169.254.169.254/latest/meta-data"
      }),
      text: () => Promise.resolve("")
    }) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/recipe", fetchImplementation, {
        validateUrl: (candidateUrl) =>
          Promise.resolve(
            candidateUrl.includes("169.254.169.254")
              ? {
                  reason: "private_address",
                  safe: false
                }
              : {
                  safe: true
                }
          ),
        timeoutMs: 1_000,
        retries: 0
      })
    ).rejects.toMatchObject({
      blockedSignals: ["unsafe_redirect:private_address"],
      reason: "blocked",
      statusCode: 302
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

describe("detectBlockedSignals", () => {
  it("detects Cloudflare-style challenge markers", () => {
    expect(
      detectBlockedSignals({
        html: "<html><title>Just a moment...</title><body>cf-chl captcha</body></html>",
        statusCode: 403
      })
    ).toEqual(expect.arrayContaining(["status:403", "cf-chl", "challenge-title"]));
  });

  it("detects BigScoots safeguard pages", () => {
    expect(
      detectBlockedSignals({
        html: "<html><title>Safeguarding Your Website — BigScoots</title><body>Safeguarding your website</body></html>",
        statusCode: 403
      })
    ).toEqual(expect.arrayContaining(["status:403", "bigscoots", "safeguarding your website"]));
  });
});
