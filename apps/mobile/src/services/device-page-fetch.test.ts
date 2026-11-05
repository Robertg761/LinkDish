import { describe, expect, it, vi } from "vitest";

import { fetchPageOnDevice, slimPageHtml } from "./device-page-fetch";

const url = "https://www.allrecipes.com/recipe/13309/rich-and-simple-french-onion-soup/";
const page = `<html><head><style>body{}</style><script src="ads.js"></script>
<script type="application/ld+json">{"@type":"Recipe","name":"Soup"}</script>
<!-- tracking --></head><body><svg><path d="M0"/></svg><h1>Soup</h1>
<script>window.big = 1;</script></body></html>`;

const htmlResponse = (body: string, status = 200, responseUrl = url): Response => {
  const response = new Response(body, { status, headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: responseUrl });
  return response;
};

describe("slimPageHtml", () => {
  it("keeps the recipe data and drops what the API never reads", () => {
    const slim = slimPageHtml(page);

    expect(slim).toContain(
      '<script type="application/ld+json">{"@type":"Recipe","name":"Soup"}</script>'
    );
    expect(slim).toContain("<h1>Soup</h1>");
    expect(slim).not.toMatch(/ads\.js|window\.big|<style|<svg|tracking/u);
  });
});

describe("slimPageHtml edge cases", () => {
  it("handles odd closing tags, unclosed elements and look-alike tag names", () => {
    expect(slimPageHtml("<p>a</p><script>x</script\t\n bar><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(slimPageHtml("<SCRIPT>x</SCRIPT><p>b</p>")).toBe("<p>b</p>");
    expect(slimPageHtml("<p>a</p><style>x")).toBe("<p>a</p>");
    expect(slimPageHtml("<p>a<!-- open")).toBe("<p>a");
    expect(slimPageHtml("<scripted>keep</scripted><svgx>keep</svgx>")).toBe(
      "<scripted>keep</scripted><svgx>keep</svgx>"
    );
    expect(
      slimPageHtml(
        '<script>const city="İstanbul";</script><script type="application/ld+json">{"a":1}</script>'
      )
    ).toBe('<script type="application/ld+json">{"a":1}</script>');
    expect(slimPageHtml('<p>a</p><svg aria-hidden="true"/><h1>Soup</h1>')).toBe(
      "<p>a</p><h1>Soup</h1>"
    );
    expect(slimPageHtml('<script type="application/json">{"a":1}</script>')).toBe(
      '<script type="application/json">{"a":1}</script>'
    );
  });
});

describe("fetchPageOnDevice", () => {
  it("returns the slimmed page and where it ended up", async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(htmlResponse(page)));

    await expect(fetchPageOnDevice(url, { fetchImplementation })).resolves.toEqual({
      html: slimPageHtml(page),
      finalUrl: url
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("asks once, as the app, and takes no for an answer", async () => {
    const fetchImplementation = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(htmlResponse("no", 402));

    await expect(fetchPageOnDevice(url, { fetchImplementation })).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]?.[1].headers).not.toHaveProperty("user-agent");
  });

  it("reads a page that only loads Cloudflare's challenge script", async () => {
    const withScript = page.replace(
      "</head>",
      '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head>'
    );
    const fetchImplementation = vi.fn(() => Promise.resolve(htmlResponse(withScript)));

    const result = await fetchPageOnDevice(url, { fetchImplementation });

    expect(result?.html).toContain("application/ld+json");
  });

  it("never uploads a page that redirected off the site or to a local address", async () => {
    for (const landedOn of [
      "http://192.168.1.1/admin",
      "http://router.local/",
      "https://elsewhere.example/recipe"
    ]) {
      const fetchImplementation = vi.fn(() => Promise.resolve(htmlResponse(page, 200, landedOn)));

      await expect(fetchPageOnDevice(url, { fetchImplementation })).resolves.toBeNull();
    }

    const sameSite = vi.fn(() =>
      Promise.resolve(htmlResponse(page, 200, "https://allrecipes.com/recipe/13309/"))
    );
    await expect(fetchPageOnDevice(url, { fetchImplementation: sameSite })).resolves.toMatchObject({
      finalUrl: "https://allrecipes.com/recipe/13309/"
    });
    await expect(
      fetchPageOnDevice("http://10.0.0.5/recipe", { fetchImplementation: sameSite })
    ).resolves.toBeNull();
  });

  it("does not download a page that is too big", async () => {
    const huge = new Response("x", {
      headers: { "content-type": "text/html", "content-length": "50000000" }
    });
    const fetchImplementation = vi.fn(() => Promise.resolve(huge));

    await expect(fetchPageOnDevice(url, { fetchImplementation })).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("gives up on challenge pages, errors and non-web links", async () => {
    const challenge = vi.fn(() => Promise.resolve(htmlResponse("<title>Just a moment...</title>")));
    const offline = vi.fn(() => Promise.reject(new Error("Network request failed")));

    await expect(fetchPageOnDevice(url, { fetchImplementation: challenge })).resolves.toBeNull();
    await expect(fetchPageOnDevice(url, { fetchImplementation: offline })).resolves.toBeNull();
    await expect(
      fetchPageOnDevice("file:///etc/hosts", { fetchImplementation: offline })
    ).resolves.toBeNull();
    expect(offline).toHaveBeenCalledOnce();
  });
});
