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

  it("tries once more as the phone's browser when the app is turned away", async () => {
    const fetchImplementation = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(htmlResponse("no", 402))
      .mockResolvedValueOnce(htmlResponse(page));

    const result = await fetchPageOnDevice(url, { fetchImplementation });

    expect(result?.html).toContain("Soup");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(
      (fetchImplementation.mock.calls[1]?.[1].headers as Record<string, string>)["user-agent"]
    ).toMatch(/Safari/u);
  });

  it("gives up on challenge pages, errors and non-web links", async () => {
    const challenge = vi.fn(() => Promise.resolve(htmlResponse("<title>Just a moment...</title>")));
    const offline = vi.fn(() => Promise.reject(new Error("Network request failed")));

    await expect(fetchPageOnDevice(url, { fetchImplementation: challenge })).resolves.toBeNull();
    await expect(fetchPageOnDevice(url, { fetchImplementation: offline })).resolves.toBeNull();
    await expect(
      fetchPageOnDevice("file:///etc/hosts", { fetchImplementation: offline })
    ).resolves.toBeNull();
    expect(offline).toHaveBeenCalledTimes(2);
  });
});
