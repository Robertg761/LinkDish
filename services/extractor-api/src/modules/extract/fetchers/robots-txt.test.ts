import { describe, expect, it, vi } from "vitest";

import {
  createRobotsAwareFetch,
  createRobotsTxtPolicy,
  isAllowedByRobots,
  LINKDISH_BOT_USER_AGENT,
  parseRobotsTxt,
  RobotsDisallowedError
} from "./robots-txt.js";

const allowAllUrls = () => Promise.resolve({ safe: true } as const);

const textResponse = (status: number, body = "", headers: Record<string, string> = {}) =>
  new Response(status === 204 || (status >= 300 && status < 400) ? null : body, {
    headers: { "content-type": "text/plain", ...headers },
    status
  });

describe("parseRobotsTxt and isAllowedByRobots", () => {
  it("uses the LinkDishBot group when there is one, otherwise the * group", () => {
    const body = `
User-agent: *
Disallow: /

User-agent: LinkDishBot
Disallow: /private/
`;
    const rules = parseRobotsTxt(body);

    expect(isAllowedByRobots(rules, "https://site.test/recipes/pie")).toBe(true);
    expect(isAllowedByRobots(rules, "https://site.test/private/x")).toBe(false);
  });

  it("falls back to the * group, as Facebook, Instagram and Pinterest publish it", () => {
    const rules = parseRobotsTxt("User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n");

    expect(isAllowedByRobots(rules, "https://www.facebook.com/page/posts/1")).toBe(false);
  });

  it("matches the group name case-insensitively and ignores a version", () => {
    const rules = parseRobotsTxt("User-agent: linkdishbot/1.0\nDisallow: /a\n");

    expect(isAllowedByRobots(rules, "https://site.test/a/b")).toBe(false);
    expect(isAllowedByRobots(rules, "https://site.test/b")).toBe(true);
  });

  it("lets the longest rule win and Allow win a tie", () => {
    const rules = parseRobotsTxt(`
User-agent: *
Disallow: /recipes/
Allow: /recipes/public/
Disallow: /tie
Allow: /tie
`);

    expect(isAllowedByRobots(rules, "https://site.test/recipes/secret")).toBe(false);
    expect(isAllowedByRobots(rules, "https://site.test/recipes/public/pie")).toBe(true);
    expect(isAllowedByRobots(rules, "https://site.test/tie")).toBe(true);
  });

  it("supports * and $ and matches the query string", () => {
    const rules = parseRobotsTxt(`
User-agent: *
Disallow: /*.pdf$
Disallow: /search?
Disallow: */print/
`);

    expect(isAllowedByRobots(rules, "https://site.test/menu.pdf")).toBe(false);
    expect(isAllowedByRobots(rules, "https://site.test/menu.pdf?x=1")).toBe(true);
    expect(isAllowedByRobots(rules, "https://site.test/search?q=pie")).toBe(false);
    expect(isAllowedByRobots(rules, "https://site.test/search")).toBe(true);
    expect(isAllowedByRobots(rules, "https://site.test/pie/print/")).toBe(false);
  });

  it("reads YouTube's real rules: watch pages allowed, the youtubei comments API not", () => {
    const rules = parseRobotsTxt(
      "User-agent: Mediapartners-Google*\nDisallow:\n\nUser-agent: *\nDisallow: /api/\nDisallow: /comment\nDisallow: /youtubei/\n"
    );

    expect(isAllowedByRobots(rules, "https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isAllowedByRobots(rules, "https://www.youtube.com/youtubei/v1/next")).toBe(false);
  });

  it("reads TikTok's real rules: oEmbed allowed, the /embed/v2 player page not", () => {
    const rules = parseRobotsTxt(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /share\nDisallow: /embed/v2\nDisallow: /link\n"
    );

    expect(isAllowedByRobots(rules, "https://www.tiktok.com/oembed?url=x")).toBe(true);
    expect(isAllowedByRobots(rules, "https://www.tiktok.com/embed/v2/123")).toBe(false);
  });

  it("treats an empty Disallow as no rule, and always allows /robots.txt", () => {
    const rules = parseRobotsTxt("User-agent: *\nDisallow:\n");

    expect(isAllowedByRobots(rules, "https://site.test/anything")).toBe(true);
    expect(
      isAllowedByRobots(parseRobotsTxt("User-agent: *\nDisallow: /\n"), "https://s.test/robots.txt")
    ).toBe(true);
  });

  it("compares percent-encoded and plain paths alike", () => {
    const rules = parseRobotsTxt("User-agent: *\nDisallow: /café\n");

    expect(isAllowedByRobots(rules, "https://site.test/caf%C3%A9/tarte")).toBe(false);
  });
});

describe("createRobotsTxtPolicy", () => {
  const policyWith = (fetchImplementation: typeof fetch, now = () => 0) =>
    createRobotsTxtPolicy({
      enabled: true,
      fetchImplementation,
      now,
      validateUrl: allowAllUrls
    });

  it("fetches robots.txt once per origin with the LinkDishBot user-agent and caches it", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(textResponse(200, "User-agent: *\nDisallow: /private\n"))
    );
    const policy = policyWith(fetchMock);

    expect(await policy.isAllowed("https://site.test/recipes/pie")).toBe(true);
    expect(await policy.isAllowed("https://site.test/private/x")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://site.test/robots.txt",
      expect.objectContaining({
        headers: expect.objectContaining({ "user-agent": LINKDISH_BOT_USER_AGENT }) as unknown
      })
    );
  });

  it("allows everything when robots.txt is missing or refused (4xx)", async () => {
    for (const status of [404, 403, 410]) {
      const policy = policyWith(() => Promise.resolve(textResponse(status)));
      expect(await policy.isAllowed("https://site.test/recipes/pie")).toBe(true);
    }
  });

  it("disallows everything while robots.txt is unreachable (5xx or network error)", async () => {
    const serverError = policyWith(() => Promise.resolve(textResponse(503)));
    expect(await serverError.isAllowed("https://site.test/recipes/pie")).toBe(false);

    const networkError = policyWith(() => Promise.reject(new Error("ECONNRESET")));
    expect(await networkError.isAllowed("https://site.test/recipes/pie")).toBe(false);
  });

  it("asks again after an unreachable answer expires", async () => {
    let clock = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(503))
      .mockResolvedValueOnce(textResponse(200, "User-agent: *\nAllow: /\n"));
    const policy = policyWith(fetchMock, () => clock);

    expect(await policy.isAllowed("https://site.test/a")).toBe(false);
    clock += 6 * 60 * 1000;
    expect(await policy.isAllowed("https://site.test/a")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows a redirect to the robots.txt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        textResponse(301, "", { location: "https://www.site.test/robots.txt" })
      )
      .mockResolvedValueOnce(textResponse(200, "User-agent: *\nDisallow: /\n"));
    const policy = policyWith(fetchMock);

    expect(await policy.isAllowed("https://site.test/a")).toBe(false);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://www.site.test/robots.txt",
      expect.anything()
    );
  });

  it("does nothing when switched off", async () => {
    const fetchMock = vi.fn();
    const policy = createRobotsTxtPolicy({
      enabled: false,
      fetchImplementation: fetchMock
    });

    expect(await policy.isAllowed("https://www.facebook.com/x")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createRobotsAwareFetch", () => {
  it("never sends a request to a disallowed URL", async () => {
    const pageFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(textResponse(200, "<html></html>"))
    );
    const policy = createRobotsTxtPolicy({
      enabled: true,
      fetchImplementation: () => Promise.resolve(textResponse(200, "User-agent: *\nDisallow: /\n")),
      validateUrl: allowAllUrls
    });
    const guardedFetch = createRobotsAwareFetch(pageFetch, policy);

    await expect(
      guardedFetch("https://www.instagram.com/p/abc/embed/captioned/")
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("passes allowed requests through unchanged", async () => {
    const pageFetch = vi.fn<typeof fetch>(() => Promise.resolve(textResponse(200, "ok")));
    const policy = createRobotsTxtPolicy({
      enabled: true,
      fetchImplementation: () => Promise.resolve(textResponse(404)),
      validateUrl: allowAllUrls
    });
    const guardedFetch = createRobotsAwareFetch(pageFetch, policy);
    const response = await guardedFetch("https://site.test/pie", { redirect: "manual" });

    expect(await response.text()).toBe("ok");
    expect(pageFetch).toHaveBeenCalledWith("https://site.test/pie", { redirect: "manual" });
  });
});
