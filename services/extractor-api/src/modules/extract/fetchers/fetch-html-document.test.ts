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

describe("fetchHtmlDocument retry policy", () => {
  it("retries a connection error once, however many retries are configured", async () => {
    const fetchImplementation = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/recipe", fetchImplementation, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 5
      })
    ).rejects.toMatchObject({ reason: "unreachable" });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retried connection succeeds", async () => {
    const fetchImplementation = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        createHtmlResponse(200, "<html><title>Soup</title><body>Soup</body></html>")
      ) as unknown as typeof fetch;

    const result = await fetchHtmlDocument("https://example.com/soup", fetchImplementation, {
      validateUrl: allowUrl,
      timeoutMs: 1_000,
      retries: 1
    });

    expect(result.document.title).toBe("Soup");
  });

  it("does not retry timeouts or server errors", async () => {
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    const timingOut = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;
    const failing = vi
      .fn()
      .mockResolvedValue(createHtmlResponse(503, "<html>down</html>")) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/slow", timingOut, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 1
      })
    ).rejects.toMatchObject({ reason: "timeout" });
    await expect(
      fetchHtmlDocument("https://example.com/down", failing, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 1
      })
    ).rejects.toMatchObject({ reason: "unreachable", statusCode: 503 });
    expect(timingOut).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("stops without retrying when the request deadline or a cancellation aborts it", async () => {
    const cancellation = new AbortController();
    const fetchImplementation = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new TypeError("fetch failed")));
        })
    ) as unknown as typeof fetch;

    const fetchPromise = fetchHtmlDocument("https://example.com/recipe", fetchImplementation, {
      validateUrl: allowUrl,
      timeoutMs: 10_000,
      retries: 1,
      signal: cancellation.signal
    });
    await vi.waitFor(() => {
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });
    cancellation.abort();

    await expect(fetchPromise).rejects.toMatchObject({ reason: "timeout" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("applies extra block-signal patterns only where the default markers apply", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(
        createHtmlResponse(
          200,
          "<html><title>Please wait - robot check</title><body>x</body></html>"
        )
      ) as unknown as typeof fetch;

    const result = await fetchHtmlDocument("https://example.com/recipe", fetchImplementation, {
      validateUrl: allowUrl,
      timeoutMs: 1_000,
      retries: 0,
      blockSignalPatterns: [/robot check/i]
    });

    expect(result.blockedSignals).toEqual(["robot check"]);
  });
});

describe("detectBlockedSignals", () => {
  it("ignores Cloudflare scripts and reCAPTCHA notices on ordinary recipe pages", () => {
    const article = `<p>${"Stir the sauce and simmer until thick. ".repeat(60)}</p>`;

    expect(
      detectBlockedSignals({
        html: [
          "<html><head><title>Best Tomato Soup</title>",
          '<script src="https://cdnjs.cloudflare.com/ajax/libs/lazysizes/5.3.2/lazysizes.min.js"></script>',
          '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>',
          '<script src="https://www.google.com/recaptcha/api.js"></script>',
          "</head><body>",
          article,
          "<p>This site is protected by reCAPTCHA. Access denied content is not here.</p>",
          "</body></html>"
        ].join(""),
        statusCode: 200
      })
    ).toEqual([]);
  });

  it("still flags a thin page whose readable text is a challenge", () => {
    expect(
      detectBlockedSignals({
        html: '<html><head><title>example.com</title><script src="https://challenges.cloudflare.com/x.js"></script></head><body><p>Verify you are human by completing the action below.</p></body></html>',
        statusCode: 200
      })
    ).toEqual(["verify you are human"]);
  });

  it("inspects the raw markup of blocking responses", () => {
    expect(
      detectBlockedSignals({
        html: `<html><head><title>Access denied</title><script>window._cf=1</script></head><body>${"x ".repeat(2_000)}<div id="cf-chl-widget"></div></body></html>`,
        statusCode: 429
      })
    ).toEqual(expect.arrayContaining(["status:429", "access denied", "cf-chl"]));
  });

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
