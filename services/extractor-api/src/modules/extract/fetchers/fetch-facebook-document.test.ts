import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { SocialFetchError } from "./errors";
import { fetchFacebookDocument, readFacebookPost } from "./fetch-facebook-document";
import { browserLikeHeaders, identifyingFetchHeaders } from "./shared";

const fixture = (name: string) =>
  readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");
const truncatedPost = fixture("facebook-post-truncated.html");
const postWithLink = fixture("facebook-post-with-link.html");
const reel = fixture("facebook-reel-full-caption.html");
const loginWall = fixture("facebook-login-wall.html");
const teaserPost = fixture("facebook-post-teaser.html");

const reelUrl = "https://www.facebook.com/reel/900000000000001/";
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init
  });
const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });
const safe = () => Promise.resolve({ safe: true as const });
const options = { timeoutMs: 5_000, validateUrl: safe };

describe("readFacebookPost", () => {
  it("reads a video's whole caption from og:title, with the page name as the author", () => {
    const post = readFacebookPost(reel);

    expect(post).toMatchObject({
      authorName: "Dinner with Dana",
      truncated: false,
      isVideo: true,
      canonicalUrl:
        "https://www.facebook.com/dinnerwithdana/videos/lemon-garlic-chicken-thighs-ingredients-4-bone-in-chicken-thighs-2-tbsp-olive/900000000000001/",
      thumbnailUrl: expect.stringContaining("fbcdn.net") as string
    });
    expect(post?.caption).toContain("Ingredients:\n4 bone-in chicken thighs");
    expect(post?.caption).toContain("3. Flip, add the garlic and lemon juice");
    expect(post?.caption).toContain("#chicken #dinner #easyrecipes");
    expect(post?.caption).not.toContain("| Dinner with Dana");
  });

  it("flags a caption that Facebook cut off at the ellipsis", () => {
    const post = readFacebookPost(truncatedPost);

    expect(post).toMatchObject({
      authorName: "Weeknight Pasta Club",
      truncated: true,
      isVideo: false
    });
    expect(post?.caption).toContain("1½ tsp Italian seasoning");
    expect(post?.caption.endsWith("Salt and pep...")).toBe(true);
  });

  it("flags a creator's own teaser (an ingredient line cut with an ellipsis above a link) as partial", () => {
    const post = readFacebookPost(teaserPost);

    expect(post).toMatchObject({ truncated: true, isVideo: true });
    expect(post?.caption).toContain("1/2 lb. chopped bacon...");
    expect(post?.caption).toContain("FULL RECIPE: https://recipes-ideas.com/garbage-bread/");
    expect(
      readFacebookPost(
        '<html><head><meta property="og:description" content="Pasta\n\n1 cup rice\n2 eggs\n\nCook it all." /></head></html>'
      )?.truncated
    ).toBe(false);
  });

  it("reads links out to other sites from Facebook's l.php wrapper, not Facebook's own links", () => {
    expect(readFacebookPost(postWithLink)?.linkedUrls).toEqual([
      "https://fixtures.linkdish.test/recipe-jsonld?fbclid=IwAR0",
      "https://example.org/"
    ]);
  });

  it("reads a caption out of JSON-LD when the meta tags have none", () => {
    const caption = "Banana bread\n\nIngredients:\n3 ripe bananas\n2 cups flour\n\nMix and bake.";
    const post = readFacebookPost(
      `<html><head><meta property="og:title" content="Facebook" /><script type="application/ld+json">${JSON.stringify(
        {
          "@context": "https://schema.org",
          "@type": "SocialMediaPosting",
          articleBody: caption,
          author: { "@type": "Person", name: "Bake Club" }
        }
      )}</script></head><body></body></html>`
    );

    expect(post).toMatchObject({ caption, authorName: "Bake Club", truncated: false });
  });

  it("drops the view and reaction counts Facebook puts in front of a description", () => {
    const post = readFacebookPost(
      '<html><head><meta property="og:description" content="1.2K views · 56 reactions | Easy oats\n\n1 cup oats\n1 cup milk\n\nSimmer." /></head></html>'
    );

    expect(post?.caption).toBe("Easy oats\n\n1 cup oats\n1 cup milk\n\nSimmer.");
  });

  it("does not take a short caption that happens to end in dots for a cut one", () => {
    const post = readFacebookPost(
      '<html><head><meta property="og:description" content="Dinner tonight..." /></head></html>'
    );

    expect(post).toMatchObject({ caption: "Dinner tonight...", truncated: false });
  });

  it("finds no post on a login wall or a page with only a page name", () => {
    expect(readFacebookPost(loginWall)).toBeNull();
    expect(
      readFacebookPost(
        '<html><head><meta property="og:title" content="Dinner with Dana" /></head></html>'
      )
    ).toBeNull();
    expect(
      readFacebookPost(
        '<html><head><meta property="og:title" content="Log in or sign up to view" /><meta property="og:description" content="Log in or sign up to view and connect with friends, family and people you know." /></head></html>'
      )
    ).toBeNull();
  });
});

describe("fetchFacebookDocument", () => {
  it("reads a reel with the honest LinkDishBot user-agent, never a browser's or Facebook's own", async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(html(reel)));

    const document = await fetchFacebookDocument(
      "https://m.facebook.com/reel/900000000000001/?mibextid=abc",
      fetchImplementation,
      options
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const [requestedUrl, init] = fetchImplementation.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];

    expect(requestedUrl).toBe(reelUrl);
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual(identifyingFetchHeaders);
    expect(JSON.stringify(init.headers)).toContain("LinkDishBot");
    expect(JSON.stringify(init.headers)).not.toMatch(/facebookexternalhit|Googlebot/iu);
    expect((init.headers as Record<string, string>)["user-agent"]).not.toBe(
      browserLikeHeaders["user-agent"]
    );
    expect(document).toMatchObject({
      kind: "text",
      origin: "facebook",
      url: "https://www.facebook.com/dinnerwithdana/videos/lemon-garlic-chicken-thighs-ingredients-4-bone-in-chicken-thighs-2-tbsp-olive/900000000000001/",
      authorName: "Dinner with Dana",
      isVideo: true,
      captionTruncated: false,
      linkedUrls: []
    });
    expect(document.text).toContain("Season the chicken with salt, pepper and oregano.");
  });

  it("reports a cut caption on a post without a video as such", async () => {
    const document = await fetchFacebookDocument(
      "https://www.facebook.com/WeeknightPastaClub/posts/creamy-garlic-parmesan-pasta/122200000000000001/",
      () => Promise.resolve(html(truncatedPost)),
      options
    );

    expect(document).toMatchObject({ isVideo: false, captionTruncated: true });
  });

  it("reports a caption longer than LinkDish keeps as cut, so a partial recipe is never imported", async () => {
    const longCaption = `Big batch soup\n\nIngredients:\n${"1 cup broth\n".repeat(500)}\nSimmer.`;
    const document = await fetchFacebookDocument(
      "https://www.facebook.com/SoupClub/posts/big-batch-soup/122200000000000002/",
      () =>
        Promise.resolve(
          html(
            `<html><head><meta property="og:description" content="${longCaption}" /></head></html>`
          )
        ),
      options
    );

    expect(document.text.length).toBe(5_000);
    expect(document).toMatchObject({ captionTruncated: true });
  });

  it("resolves /share/, fb.me and fb.watch links by following their redirects on Facebook", async () => {
    for (const shortUrl of [
      "https://www.facebook.com/share/r/1AbCdEfGhI/",
      "https://fb.me/abc123XYZ",
      "https://fb.watch/xYz_12AbC/"
    ]) {
      const fetchImplementation = vi
        .fn()
        .mockResolvedValueOnce(redirect("https://m.facebook.com/reel/900000000000001/?s=1"))
        .mockResolvedValueOnce(html(reel));
      const validateUrl = vi.fn(safe);

      const document = await fetchFacebookDocument(shortUrl, fetchImplementation, {
        timeoutMs: 5_000,
        validateUrl
      });

      expect(fetchImplementation.mock.calls.map((call) => call[0] as string)).toEqual([
        shortUrl,
        reelUrl
      ]);
      expect(validateUrl).toHaveBeenCalledTimes(2);
      expect(document.origin).toBe("facebook");
    }
  });

  it.each([
    ["a login", "https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Freel%2F1"],
    [
      "a mobile login",
      "https://m.facebook.com/login.php?next=https%3A%2F%2Fm.facebook.com%2Freel%2F1"
    ],
    ["a checkpoint", "https://www.facebook.com/checkpoint/1501092823525282/"],
    ["a consent page", "https://www.facebook.com/privacy/consent/gdp/"]
  ])("fails as blocked when Facebook redirects to %s", async (_name, location) => {
    const fetchImplementation = vi.fn(() => Promise.resolve(redirect(location)));

    await expect(
      fetchFacebookDocument(reelUrl, fetchImplementation as unknown as typeof fetch, options)
    ).rejects.toMatchObject({ name: "SocialFetchError", reason: "blocked" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("fails as blocked on a generic page with no post content", async () => {
    await expect(
      fetchFacebookDocument(reelUrl, () => Promise.resolve(html(loginWall)), options)
    ).rejects.toMatchObject({ reason: "blocked", statusCode: 200 });
  });

  it.each([
    [400, "blocked"],
    [403, "blocked"],
    [429, "blocked"],
    [404, "not_found"],
    [500, "unreachable"]
  ])("maps HTTP %i to %s", async (status, reason) => {
    await expect(
      fetchFacebookDocument(reelUrl, () => Promise.resolve(html("Error", { status })), options)
    ).rejects.toMatchObject({ reason, statusCode: status });
  });

  it("never follows a redirect off Facebook, and stops redirect loops", async () => {
    const offSite = vi.fn(() => Promise.resolve(redirect("https://evil.example/reel/1")));
    const loop = vi.fn(() => Promise.resolve(redirect(reelUrl)));

    await expect(
      fetchFacebookDocument(reelUrl, offSite as unknown as typeof fetch, options)
    ).rejects.toMatchObject({ reason: "blocked" });
    expect(offSite).toHaveBeenCalledTimes(1);

    await expect(
      fetchFacebookDocument(reelUrl, loop as unknown as typeof fetch, options)
    ).rejects.toMatchObject({ reason: "blocked" });
    expect(loop.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it("validates every hop and refuses an unsafe one before fetching it", async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(redirect("https://fb.me/second")));
    const validateUrl = vi
      .fn()
      .mockResolvedValueOnce({ safe: true })
      .mockResolvedValueOnce({ safe: false, reason: "private_address" });

    await expect(
      fetchFacebookDocument("https://fb.me/first", fetchImplementation as unknown as typeof fetch, {
        timeoutMs: 5_000,
        validateUrl
      })
    ).rejects.toMatchObject({ reason: "blocked" });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("rejects links that are not a post and non-HTML answers", async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(html(reel)));

    await expect(
      fetchFacebookDocument(
        "https://www.facebook.com/cookpage",
        fetchImplementation as unknown as typeof fetch,
        options
      )
    ).rejects.toBeInstanceOf(SocialFetchError);
    expect(fetchImplementation).not.toHaveBeenCalled();

    await expect(
      fetchFacebookDocument(
        reelUrl,
        () =>
          Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } })),
        options
      )
    ).rejects.toMatchObject({ reason: "unsupported_content_type" });
  });

  it("turns an aborted request into a timeout", async () => {
    const fetchImplementation = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );

    await expect(
      fetchFacebookDocument(reelUrl, fetchImplementation as unknown as typeof fetch, {
        ...options,
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ reason: "timeout" });
  });
});
