import { describe, expect, it, vi } from "vitest";

import { createIosSourceRuntime } from "./ios-source-runtime";

import type { ExtractorRuntime } from "../types";

const source = "https://publicdomainrecipes.com/basic-waffles/";
const robots = "https://publicdomainrecipes.com/robots.txt";
const openRobots = () => new Response("User-agent: *\nDisallow:\n");
const html = () =>
  new Response("<html><title>Waffles</title><body>Recipe</body></html>", {
    headers: { "content-type": "text/html" }
  });
const publicUrl = vi.fn(() => Promise.resolve({ safe: true as const }));
const base = () =>
  ({
    fetchImplementation: vi.fn(),
    fetchHtmlDocument: vi.fn(),
    fetchYouTubeDocument: vi.fn(),
    fetchSocialDocument: vi.fn(),
    fetchSocialVideo: vi.fn(),
    fetchFacebookVideo: vi.fn(),
    searchCreatorSite: vi.fn(),
    extractionCache: { get: vi.fn(), set: vi.fn() },
    fallbackExtractor: {
      available: false,
      providerName: "none",
      extract: () => Promise.resolve(null)
    },
    validateSourceUrl: publicUrl,
    dispose: () => Promise.resolve()
  }) as unknown as ExtractorRuntime;

describe("iPhone restricted source runtime", () => {
  it.each([
    "https://outside.example/recipe/",
    "https://publicdomainrecipes.com.evil.example/recipe/",
    "http://publicdomainrecipes.com/recipe/",
    "https://publicdomainrecipes.com/redirect/?url=https://outside.example"
  ])("blocks a redirect before requesting %s", async (destination) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(openRobots())
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: destination } })
      );
    const runtime = createIosSourceRuntime(base(), transport, publicUrl);
    await expect(runtime.fetchHtmlDocument(source)).rejects.toThrow("Refused unsafe redirect");
    expect(transport.mock.calls.map(([url]) => url)).toEqual([robots, source]);
    expect(transport.mock.calls.every(([, options]) => options?.redirect === "manual")).toBe(true);
  });

  it("follows a permitted redirect with validation at each hop", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(openRobots())
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: "/banana-bread/" } })
      )
      .mockResolvedValueOnce(html());
    const runtime = createIosSourceRuntime(base(), transport, publicUrl);
    const result = await runtime.fetchHtmlDocument(source);
    expect(result.document.finalUrl).toBe("https://publicdomainrecipes.com/banana-bread/");
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("blocks initial and secondary page URLs without any request", async () => {
    const transport = vi.fn<typeof fetch>();
    const runtime = createIosSourceRuntime(base(), transport, publicUrl);
    await expect(runtime.fetchHtmlDocument("https://outside.example/recipe/")).rejects.toThrow(
      "outside"
    );
    expect(await runtime.validateSourceUrl("https://outside.example/recipe/")).toMatchObject({
      safe: false
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "User-agent: *\nDisallow: /",
    "<html>Not robots</html>",
    "User-agent: *\nDisallow: /private/"
  ])("fails closed on changed robots rules: %s", async (rules) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(rules));
    await expect(
      createIosSourceRuntime(base(), transport, publicUrl).fetchHtmlDocument(source)
    ).rejects.toThrow("outside");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not follow robots redirects or retry a bot challenge through a browser", async () => {
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://outside.example/robots.txt" }
      })
    );
    await expect(
      createIosSourceRuntime(base(), redirect, publicUrl).fetchHtmlDocument(source)
    ).rejects.toThrow();
    expect(redirect).toHaveBeenCalledTimes(1);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(openRobots())
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const original = base();
    const legacyFetch = vi.spyOn(original, "fetchHtmlDocument");
    await expect(
      createIosSourceRuntime(original, transport, publicUrl).fetchHtmlDocument(source)
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it("preserves SSRF validation and cannot inherit alternate fetchers or caches", async () => {
    const transport = vi.fn<typeof fetch>();
    const original = base();
    const runtime = createIosSourceRuntime(original, transport, () =>
      Promise.resolve({
        safe: false,
        reason: "private_address"
      })
    );
    await expect(runtime.fetchHtmlDocument(source)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.extractionCache).toBeUndefined();
    expect(runtime.fetchSocialDocument).toBeUndefined();
    expect(runtime.fetchSocialVideo).toBeUndefined();
    expect(runtime.fetchFacebookVideo).toBeUndefined();
    expect(runtime.searchCreatorSite).toBeUndefined();
    expect(runtime.videoRecipeReader).toBeUndefined();
    await expect(runtime.fetchYouTubeDocument(source, "id")).rejects.toThrow();
    expect(original.extractionCache).toBeDefined();
  });
});
