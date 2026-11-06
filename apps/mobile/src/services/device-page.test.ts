import { describe, expect, it } from "vitest";

import {
  PAGE_SHOWN_SCRIPT,
  buildCaptureScript,
  pageProblemMessage,
  prepareCapturedPage,
  readPageViewMessage,
  slimPageHtml,
  unwrapFacebookLinkWrapper
} from "./device-page";

const url = "https://www.allrecipes.com/recipe/13309/rich-and-simple-french-onion-soup/";
const page = `<html><head><style>body{}</style><script src="ads.js"></script>
<script type="application/ld+json">{"@type":"Recipe","name":"Soup"}</script>
<!-- tracking --></head><body><svg><path d="M0"/></svg><h1>Soup</h1>
<script>window.big = 1;</script></body></html>`;

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

describe("prepareCapturedPage", () => {
  it("sends the slimmed page the person saved, with its address", () => {
    expect(prepareCapturedPage(url, { href: url, html: page })).toEqual({
      page: { html: slimPageHtml(page), finalUrl: url }
    });
  });

  it("takes another page on the same site, and the target of a Facebook-wrapped link", () => {
    const other = "https://allrecipes.com/recipe/1/other/";
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(url)}&h=abc`;

    expect(prepareCapturedPage(url, { href: other, html: page })).toMatchObject({
      page: { finalUrl: other }
    });
    expect(prepareCapturedPage(wrapped, { href: url, html: page })).toMatchObject({
      page: { finalUrl: url }
    });
  });

  it("never sends a page on another site, an IP address or a local name", () => {
    for (const href of [
      "https://www.example.com/recipe",
      "http://10.0.0.1/recipe",
      "http://router.local/",
      "file:///etc/hosts"
    ]) {
      expect(prepareCapturedPage(url, { href, html: page })).toEqual({ problem: "other_site" });
    }

    for (const [requested, href] of [
      ["https://recipes.example.co.uk/soup", "https://unrelated.co.uk/soup"],
      ["https://cook.wordpress.com/soup", "https://other.wordpress.com/soup"]
    ] as const) {
      expect(prepareCapturedPage(requested, { href, html: page })).toEqual({
        problem: "other_site"
      });
    }

    expect(
      prepareCapturedPage("https://recipes.example.co.uk/soup", {
        href: "https://www.example.co.uk/soup",
        html: page
      })
    ).toHaveProperty("page");
  });

  it("says when the page is still the site's check, empty or too big", () => {
    expect(
      prepareCapturedPage(url, { href: url, html: "<title>Just a moment...</title>" })
    ).toEqual({ problem: "challenge" });
    expect(prepareCapturedPage(url, { href: url, html: "<script>x</script>" })).toEqual({
      problem: "empty"
    });
    expect(
      prepareCapturedPage(url, { href: url, html: `<p>${"a".repeat(3_000_001)}</p>` })
    ).toEqual({ problem: "too_large" });
  });

  it("reads a page that only loads Cloudflare's challenge script", () => {
    const html = `<title>Soup</title><script src="/cdn-cgi/challenge-platform/x.js"></script>${page}`;

    expect(prepareCapturedPage(url, { href: url, html })).toHaveProperty("page");
  });
});

describe("page view messages", () => {
  it("reads what the app's own scripts post and ignores everything else", () => {
    expect(
      readPageViewMessage(
        JSON.stringify({ type: "linkdish:page-shown", href: url, title: "Soup" })
      )
    ).toEqual({ kind: "shown", href: url, title: "Soup" });
    expect(
      readPageViewMessage(
        JSON.stringify({ type: "linkdish:page-captured", nonce: "n1", href: url, html: page })
      )
    ).toEqual({ kind: "captured", nonce: "n1", href: url, html: page });

    for (const data of [
      "not json",
      "null",
      JSON.stringify({ type: "ad:ready", href: url }),
      JSON.stringify({ type: "linkdish:page-captured", href: url, html: page }),
      JSON.stringify({ type: "linkdish:page-shown" })
    ]) {
      expect(readPageViewMessage(data)).toBeNull();
    }
  });

  it("posts only from the top page, and the capture carries its tap's nonce", () => {
    const posted: string[] = [];
    const run = (script: string, top: boolean) => {
      const window = {
        ReactNativeWebView: { postMessage: (data: string) => posted.push(data) },
        top: undefined as unknown
      };
      window.top = top ? window : {};
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const runScript = new Function("window", "location", "document", script) as (
        ...scope: unknown[]
      ) => void;
      runScript(
        window,
        { href: url },
        { title: "Soup", documentElement: { outerHTML: page } }
      );
    };

    run(PAGE_SHOWN_SCRIPT, false);
    run(buildCaptureScript("n1"), false);
    expect(posted).toEqual([]);

    run(PAGE_SHOWN_SCRIPT, true);
    run(buildCaptureScript('n"1'), true);
    expect(posted.map(readPageViewMessage)).toEqual([
      { kind: "shown", href: url, title: "Soup" },
      { kind: "captured", nonce: 'n"1', href: url, html: page }
    ]);
  });
});

describe("unwrapFacebookLinkWrapper", () => {
  it("opens the link's own target", () => {
    expect(
      unwrapFacebookLinkWrapper(`https://lm.facebook.com/l.php?u=${encodeURIComponent(url)}`)
    ).toBe(url);
    expect(unwrapFacebookLinkWrapper(url)).toBe(url);
    expect(
      unwrapFacebookLinkWrapper("https://l.facebook.com/l.php?u=javascript%3Aalert(1)")
    ).toBe("https://l.facebook.com/l.php?u=javascript%3Aalert(1)");
  });
});

describe("pageProblemMessage", () => {
  it("names the site", () => {
    expect(pageProblemMessage("other_site", url)).toContain("allrecipes.com");
  });
});
