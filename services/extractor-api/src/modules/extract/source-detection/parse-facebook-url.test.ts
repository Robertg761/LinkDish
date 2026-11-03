import { describe, expect, it } from "vitest";

import { detectSourceType } from "./detect-source-type";
import { parseFacebookLink, parseFacebookPost, unwrapFacebookRedirect } from "./parse-facebook-url";

const www = "https://www.facebook.com";

describe("parseFacebookLink", () => {
  it.each([
    [
      "a page post with a slug and id",
      "https://www.facebook.com/GrandmastastyRecipes/posts/cheesy-garlic-butter-beef-spaghetti/122210837864317948/",
      `${www}/GrandmastastyRecipes/posts/cheesy-garlic-butter-beef-spaghetti/122210837864317948/`,
      false
    ],
    [
      "a pfbid post",
      "https://www.facebook.com/cooking.page/posts/pfbid02AbCdEf123?__cft__[0]=AZ&__tn__=%2CO",
      `${www}/cooking.page/posts/pfbid02AbCdEf123`,
      false
    ],
    [
      "a public group post",
      "https://www.facebook.com/groups/12345/posts/67890/",
      `${www}/groups/12345/posts/67890/`,
      false
    ],
    [
      "a group permalink",
      "https://www.facebook.com/groups/dinnerclub/permalink/67890/",
      `${www}/groups/dinnerclub/permalink/67890/`,
      false
    ],
    [
      "permalink.php",
      "https://www.facebook.com/permalink.php?story_fbid=pfbid0abc&id=100001&fbclid=IwAR0&ref=share",
      `${www}/permalink.php?story_fbid=pfbid0abc&id=100001`,
      false
    ],
    [
      "story.php on the mobile site",
      "https://m.facebook.com/story.php?story_fbid=123456&id=654321&mibextid=Nif5oz",
      `${www}/story.php?story_fbid=123456&id=654321`,
      false
    ],
    [
      "a photo.php link",
      "https://mbasic.facebook.com/photo.php?fbid=1234567890&set=a.111&type=3",
      `${www}/photo.php?fbid=1234567890&set=a.111`,
      false
    ],
    [
      "a /photo link",
      "https://www.facebook.com/photo/?fbid=1234567890",
      `${www}/photo/?fbid=1234567890`,
      false
    ],
    [
      "a page photo",
      "https://www.facebook.com/cookpage/photos/a.123456/789012345/",
      `${www}/cookpage/photos/a.123456/789012345/`,
      false
    ],
    [
      "a watch link",
      "https://www.facebook.com/watch/?v=123456789&ref=sharing",
      `${www}/watch/?v=123456789`,
      true
    ],
    [
      "a watch link without the slash",
      "https://web.facebook.com/watch?v=123456789",
      `${www}/watch?v=123456789`,
      true
    ],
    [
      "video.php",
      "https://www.facebook.com/video.php?v=123456789",
      `${www}/video.php?v=123456789`,
      true
    ],
    [
      "a page video",
      "https://www.facebook.com/cookpage/videos/123456789/",
      `${www}/cookpage/videos/123456789/`,
      true
    ],
    [
      "a page video with a slug",
      "https://www.facebook.com/cookpage/videos/lemon-chicken/123456789/",
      `${www}/cookpage/videos/lemon-chicken/123456789/`,
      true
    ],
    [
      "a reel",
      "https://www.facebook.com/reel/725554398033140/?s=single_unit",
      `${www}/reel/725554398033140/`,
      true
    ],
    [
      "a reel on the mobile site",
      "https://m.facebook.com/reel/725554398033140",
      `${www}/reel/725554398033140`,
      true
    ],
    [
      "a reel on touch.",
      "https://touch.facebook.com/reel/725554398033140/",
      `${www}/reel/725554398033140/`,
      true
    ],
    [
      "a reel on fb.com",
      "https://fb.com/reel/725554398033140",
      `${www}/reel/725554398033140`,
      true
    ],
    [
      "a post on www.fb.com",
      "https://www.fb.com/cookpage/posts/123456789",
      `${www}/cookpage/posts/123456789`,
      false
    ],
    [
      "a plain http link",
      "http://facebook.com/reel/725554398033140/",
      `${www}/reel/725554398033140/`,
      true
    ]
  ])("reads %s as a post", (_name, url, canonical, isVideo) => {
    expect(parseFacebookLink(url)).toEqual({ kind: "post", url: canonical, isVideo });
  });

  it.each([
    [
      "/share/p/",
      "https://www.facebook.com/share/p/1AbCdEfGhI/?mibextid=wwXIfr",
      `${www}/share/p/1AbCdEfGhI/`
    ],
    ["/share/r/", "https://m.facebook.com/share/r/1AbCdEfGhI/", `${www}/share/r/1AbCdEfGhI/`],
    ["/share/v/", "https://www.facebook.com/share/v/1AbCdEfGhI", `${www}/share/v/1AbCdEfGhI`],
    ["fb.me", "https://fb.me/abc123XYZ", "https://fb.me/abc123XYZ"],
    ["fb.watch", "https://fb.watch/xYz_12AbC/", "https://fb.watch/xYz_12AbC/"]
  ])("reads %s as a short link to follow", (_name, url, expected) => {
    expect(parseFacebookLink(url)).toEqual({ kind: "short", url: expected });
  });

  it("unwraps l.facebook.com and lm.facebook.com to their target", () => {
    const target = "https://cookblog.example/lemon-chicken?utm_source=fb";
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=AT0abc&s=1`;

    expect(parseFacebookLink(wrapped)).toEqual({ kind: "redirect", target });
    expect(
      parseFacebookLink(`https://lm.facebook.com/l.php?u=${encodeURIComponent(target)}`)
    ).toEqual({ kind: "redirect", target });
    expect(parseFacebookLink("https://l.facebook.com/l.php?h=AT0abc")).toEqual({ kind: "other" });
    expect(parseFacebookLink("https://l.facebook.com/l.php?u=javascript%3Aalert(1)")).toEqual({
      kind: "other"
    });
  });

  it.each([
    "https://www.facebook.com/",
    "https://www.facebook.com/cookpage",
    "https://www.facebook.com/cookpage/photos",
    "https://www.facebook.com/profile.php?id=100001",
    "https://www.facebook.com/permalink.php?id=100001",
    "https://www.facebook.com/watch/",
    "https://www.facebook.com/groups/dinnerclub/",
    "https://www.facebook.com/events/12345/",
    "https://fb.me/",
    "https://fb.me/a/b"
  ])("reads %s as a Facebook page that is not a post", (url) => {
    expect(parseFacebookLink(url)).toEqual({ kind: "other" });
  });

  it.each([
    "https://notfacebook.com/reel/725554398033140/",
    "https://facebook.com.example.net/reel/725554398033140/",
    "https://www.facebook.com.evil.test/reel/725554398033140/",
    "https://fakefb.com/reel/725554398033140/",
    "https://xfb.me/abc123",
    "https://example.com/?u=https://www.facebook.com/reel/1/",
    "https://l.notfacebook.com/l.php?u=https%3A%2F%2Fexample.com%2F",
    "ftp://www.facebook.com/reel/725554398033140/",
    "not a url"
  ])("does not treat %s as Facebook", (url) => {
    expect(parseFacebookLink(url)).toBeNull();
    expect(parseFacebookPost(url)).toBeNull();
  });
});

describe("unwrapFacebookRedirect", () => {
  it("returns the target of a link wrapper, including nested ones", () => {
    const inner = `https://l.facebook.com/l.php?u=${encodeURIComponent("https://cookblog.example/stew")}`;

    expect(unwrapFacebookRedirect(inner)).toBe("https://cookblog.example/stew");
    expect(
      unwrapFacebookRedirect(`https://lm.facebook.com/l.php?u=${encodeURIComponent(inner)}`)
    ).toBe("https://cookblog.example/stew");
  });

  it("unwraps to a Facebook post, which then takes the Facebook path", () => {
    const post = "https://www.facebook.com/reel/725554398033140/";

    expect(
      unwrapFacebookRedirect(`https://l.facebook.com/l.php?u=${encodeURIComponent(post)}`)
    ).toBe(post);
  });

  it("leaves every other URL alone", () => {
    for (const url of [
      "https://www.facebook.com/reel/725554398033140/",
      "https://cookblog.example/stew",
      "https://l.facebook.com/l.php",
      "not a url"
    ]) {
      expect(unwrapFacebookRedirect(url)).toBe(url);
    }
  });
});

describe("detectSourceType for Facebook", () => {
  it.each([
    "https://www.facebook.com/GrandmastastyRecipes/posts/cheesy-garlic/122210837864317948/",
    "https://www.facebook.com/reel/725554398033140/",
    "https://m.facebook.com/story.php?story_fbid=1&id=2",
    "https://mbasic.facebook.com/permalink.php?story_fbid=1&id=2",
    "https://web.facebook.com/watch/?v=123",
    "https://www.facebook.com/share/r/1AbCdEfGhI/",
    "https://fb.watch/xYz_12AbC/",
    "https://fb.me/abc123XYZ",
    "https://fb.com/reel/725554398033140"
  ])("gives %s the Facebook adapter", (url) => {
    expect(detectSourceType(url)).toMatchObject({ sourceType: "social", adapterKey: "facebook" });
  });

  it("keeps other Facebook pages, and a bare l.facebook.com wrapper, unsupported social", () => {
    for (const url of [
      "https://www.facebook.com/cookpage",
      "https://www.facebook.com/profile.php?id=1",
      "https://l.facebook.com/l.php?u=https%3A%2F%2Fcookblog.example%2Fstew"
    ]) {
      expect(detectSourceType(url)).toMatchObject({ sourceType: "social", adapterKey: null });
    }
  });

  it("does not match lookalike hosts", () => {
    for (const url of [
      "https://notfacebook.com/reel/725554398033140/",
      "https://facebook.com.example.test/reel/725554398033140/",
      "https://fakefb.com/reel/1",
      "https://fb.me.example.test/abc123"
    ]) {
      expect(detectSourceType(url)).toMatchObject({ sourceType: "article", adapterKey: null });
    }
  });
});
