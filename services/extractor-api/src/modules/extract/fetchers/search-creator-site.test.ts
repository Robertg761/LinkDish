import { describe, expect, it, vi } from "vitest";

import { searchCreatorSite } from "./search-creator-site";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=UTF-8" },
    ...init
  });
const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });
const safe = () => Promise.resolve({ safe: true as const });
const options = { timeoutMs: 5_000, validateUrl: safe };
/* The tests only ever pass string URLs to fetch. */
const urlOf = (input: unknown): string => input as string;

describe("searchCreatorSite", () => {
  it("reads WordPress's search API, decoding titles and dropping other sites", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        json([
          {
            title: "Buffalo Chicken Blooming Quesadilla",
            url: "https://fedbysab.com/buffalo-chicken-blooming-quesadilla/"
          },
          { title: "Mom&#8217;s Chicken Ring", url: "https://www.fedbysab.com/moms-ring/" },
          { title: "Elsewhere", url: "https://other.example/ring/" },
          { title: "Category", url: "https://fedbysab.com/category/chicken/" },
          { title: "", url: "https://fedbysab.com/untitled/" },
          { nonsense: true }
        ])
      )
    );

    const results = await searchCreatorSite(
      "fedbysab.com",
      "Buffalo Chicken Ring",
      fetchImplementation,
      options
    );

    expect(results).toEqual([
      {
        title: "Buffalo Chicken Blooming Quesadilla",
        url: "https://fedbysab.com/buffalo-chicken-blooming-quesadilla/"
      },
      { title: "Mom’s Chicken Ring", url: "https://www.fedbysab.com/moms-ring/" }
    ]);

    const requested = new URL(urlOf(fetchImplementation.mock.calls[0]?.[0]));
    expect(requested.origin + requested.pathname).toBe("https://fedbysab.com/wp-json/wp/v2/search");
    expect(requested.searchParams.get("search")).toBe("Buffalo Chicken Ring");
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect that stays on the site", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("https://www.fedbysab.com/wp-json/wp/v2/search?search=ring"))
      .mockResolvedValueOnce(
        json([{ title: "Chicken Ring", url: "https://www.fedbysab.com/ring/" }])
      );

    await expect(
      searchCreatorSite("fedbysab.com", "ring", fetchImplementation, options)
    ).resolves.toEqual([{ title: "Chicken Ring", url: "https://www.fedbysab.com/ring/" }]);
  });

  it("falls back to the /?s= search page when the API is off", async () => {
    const page = `<html><body><main>
      <nav><a href="https://cook.example/category/dinner/">Dinner</a></nav>
      <article><h2 class="entry-title"><a href="https://cook.example/lemon-orzo-soup/">Lemon Orzo Soup</a></h2></article>
      <article><h2><a href="/garlic-steak-bites/#comments">Garlic Steak Bites</a></h2></article>
      <article><h2><a href="https://elsewhere.example/soup/">Other Soup</a></h2></article>
      <article><h2><a href="https://cook.example/?s=soup&paged=2">Next page</a></h2></article>
    </main></body></html>`;
    const fetchImplementation = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        urlOf(input).includes("/wp-json/") ? new Response("not found", { status: 404 }) : html(page)
      )
    );

    const results = await searchCreatorSite(
      "cook.example",
      "orzo soup",
      fetchImplementation,
      options
    );

    expect(results).toEqual([
      { title: "Lemon Orzo Soup", url: "https://cook.example/lemon-orzo-soup/" },
      { title: "Garlic Steak Bites", url: "https://cook.example/garlic-steak-bites/" }
    ]);
    expect(urlOf(fetchImplementation.mock.calls[1]?.[0])).toBe("https://cook.example/?s=orzo+soup");
  });

  it("never leaves the site or reaches an unsafe address", async () => {
    const offSite = vi.fn<typeof fetch>(() =>
      Promise.resolve(redirect("https://evil.example/wp-json/wp/v2/search"))
    );

    await expect(searchCreatorSite("cook.example", "soup", offSite, options)).resolves.toEqual([]);
    expect(offSite.mock.calls.map(([url]) => new URL(urlOf(url)).hostname)).toEqual([
      "cook.example",
      "cook.example"
    ]);

    const fetchImplementation = vi.fn<typeof fetch>();
    const unsafe = () =>
      Promise.resolve({ safe: false as const, reason: "private_address" as const });

    await expect(
      searchCreatorSite("cook.example", "soup", fetchImplementation, {
        ...options,
        validateUrl: unsafe
      })
    ).resolves.toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
