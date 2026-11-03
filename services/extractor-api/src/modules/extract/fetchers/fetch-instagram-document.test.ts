import { describe, expect, it, vi } from "vitest";

import { buildHtmlSourceDocument } from "../html/parsed-html-document";

import { BrowserFetchError, SocialFetchError } from "./errors";
import { fetchInstagramDocument, toInstagramEmbedUrl } from "./fetch-instagram-document";

import type { FetchResult } from "../types";

const shortcode = "DAbc123xyz";
const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
const caption = [
  "Creamy garlic pasta 🍝",
  "Ingredients:",
  "200 g spaghetti",
  "3 cloves garlic",
  "Method:",
  "Cook the pasta, then toss it with the garlic."
].join("\n");

const rendered = (html: string, finalUrl = embedUrl): FetchResult => ({
  document: buildHtmlSourceDocument({
    url: embedUrl,
    finalUrl,
    html,
    contentType: "text/html",
    blockedSignals: [],
    statusCode: 200
  }),
  mode: "browser",
  blockedSignals: []
});

const page = (body: string, head = "") =>
  `<!doctype html><html><head><title>Instagram</title>${head}</head><body>${body}</body></html>`;

describe("fetchInstagramDocument", () => {
  it("renders the post's public embed page, whatever form the link takes", async () => {
    const renderPage = vi.fn(() => Promise.resolve(rendered(page(""))));

    await fetchInstagramDocument(
      `https://www.instagram.com/cookcreator/reel/${shortcode}/?igsh=abc`,
      renderPage
    ).catch(() => undefined);

    expect(toInstagramEmbedUrl(shortcode)).toBe(embedUrl);
    expect(renderPage).toHaveBeenCalledWith(embedUrl);
  });

  it("reads the caption, author, image and media type from the page state", async () => {
    const context = {
      context: {
        gql_data: {
          shortcode_media: {
            shortcode,
            is_video: true,
            display_url: "https://scontent.cdninstagram.com/v/cover.jpg",
            owner: { username: "cookcreator" },
            edge_media_to_caption: { edges: [{ node: { text: caption } }] }
          }
        }
      }
    };
    const html = page(
      "",
      `<script>s.handle({"contextJSON":${JSON.stringify(JSON.stringify(context))}})</script>`
    );

    const document = await fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(html))
    );

    expect(document).toEqual({
      kind: "text",
      url: `https://www.instagram.com/reel/${shortcode}/`,
      origin: "instagram",
      text: caption,
      title: null,
      authorName: "cookcreator",
      thumbnailUrl: "https://scontent.cdninstagram.com/v/cover.jpg",
      isVideo: true
    });
  });

  it("reads the v1 media record's caption and skips other posts' records", async () => {
    const context = {
      related: [{ code: "OtherPost1", caption: { text: "not this one" }, user: { username: "x" } }],
      media: {
        code: shortcode,
        media_type: 1,
        caption: { text: caption },
        user: { username: "cookcreator" }
      }
    };
    const html = page(
      "",
      `<script>({"contextJSON":${JSON.stringify(JSON.stringify(context))}})</script>`
    );

    const document = await fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(html))
    );

    expect(document).toMatchObject({
      url: `https://www.instagram.com/p/${shortcode}/`,
      text: caption,
      authorName: "cookcreator",
      isVideo: false
    });
  });

  it("drops the invisible separators creators use to keep empty lines", async () => {
    const separated =
      "Lemon pasta ☀️\u2063\n\u2800\n2 tbsp butter\u2063 \n1 cup cream\u2063\n\u2063\nMelt the butter.";
    const html = page(
      "",
      `<script>(${JSON.stringify({
        contextJSON: JSON.stringify({
          gql_data: {
            shortcode_media: {
              shortcode,
              owner: { username: "cookcreator" },
              edge_media_to_caption: { edges: [{ node: { text: separated } }] }
            }
          }
        })
      })})</script>`
    );

    const document = await fetchInstagramDocument(
      `https://www.instagram.com/reel/${shortcode}/`,
      () => Promise.resolve(rendered(html))
    );

    expect(document.text).toBe("Lemon pasta ☀️\n\n2 tbsp butter\n1 cup cream\n\nMelt the butter.");
  });

  it("reads the caption markup when the page state has the post without its caption", async () => {
    const context = {
      gql_data: {
        shortcode_media: {
          shortcode,
          is_video: true,
          owner: { username: "cookcreator" },
          edge_media_to_caption: { edges: [] }
        }
      }
    };
    const html = page(
      `<div class="Caption"><a class="CaptionUsername">cookcreator</a><br>${caption
        .split("\n")
        .join("<br>")}</div>`,
      `<script>({"contextJSON":${JSON.stringify(JSON.stringify(context))}})</script>`
    );

    const document = await fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(html))
    );

    expect(document).toMatchObject({ text: caption, authorName: "cookcreator", isVideo: true });
  });

  it("reads a caption edge that sits directly in a script", async () => {
    const html = page(
      "",
      `<script>require(${JSON.stringify({
        edge_media_to_caption: { edges: [{ node: { text: caption } }] },
        owner: { id: "1", username: "cookcreator" }
      })})</script>`
    );

    const document = await fetchInstagramDocument(
      `https://www.instagram.com/reel/${shortcode}/`,
      () => Promise.resolve(rendered(html))
    );

    expect(document).toMatchObject({
      url: `https://www.instagram.com/reel/${shortcode}/`,
      text: caption,
      authorName: "cookcreator",
      isVideo: true
    });
  });

  it("reads the classic embed caption markup", async () => {
    const html = page(
      `<div class="Embed"><img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/v/photo.jpg">
      <div class="Caption"><a class="CaptionUsername" href="/cookcreator/">cookcreator</a><br><br>${caption
        .split("\n")
        .join("<br>")}<div class="CaptionComments"><a>View all 12 comments</a></div></div></div>`
    );

    const document = await fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(html))
    );

    expect(document).toMatchObject({
      text: caption,
      authorName: "cookcreator",
      thumbnailUrl: "https://scontent.cdninstagram.com/v/photo.jpg",
      isVideo: false
    });
  });

  it("falls back to the rendered text between the like count and the comments", async () => {
    const html = page(
      [
        "<div><span>cookcreator</span></div><div>538K followers</div><div>View profile</div>",
        "<div>Like</div><div>Comment</div><div>Share</div><div>Save</div>",
        "<div>238 likes</div>",
        `<div><span>cookcreator</span></div><div><span>${caption.split("\n").join("<br>")}</span></div>`,
        "<div>View all 10 comments</div><div>Add a comment...</div>"
      ].join("")
    );

    const document = await fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(html))
    );

    expect(document).toMatchObject({ text: caption, authorName: "cookcreator" });
  });

  it("keeps a post with no caption, so the import explains there is no recipe", async () => {
    const html = page("<div>12 likes</div><div>cookcreator</div><div>View all 3 comments</div>");

    const document = await fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(html))
    );

    expect(document).toMatchObject({ text: "", authorName: "cookcreator" });
  });

  it("treats a login page as blocked and a removed post as not found", async () => {
    const login = fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(page("Log in"), "https://www.instagram.com/accounts/login/?next=x"))
    );
    const removed = fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(
        rendered(
          page(
            "<div>The link to this photo or video may be broken, or the post may have been removed.</div>"
          )
        )
      )
    );
    const shell = fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.resolve(rendered(page("<div>Instagram</div>")))
    );

    await expect(login).rejects.toMatchObject({ name: "SocialFetchError", reason: "blocked" });
    await expect(removed).rejects.toMatchObject({ name: "SocialFetchError", reason: "not_found" });
    await expect(shell).rejects.toMatchObject({ name: "SocialFetchError", reason: "blocked" });
  });

  it("reports a failed render as a social fetch failure with the same reason", async () => {
    const result = fetchInstagramDocument(`https://www.instagram.com/p/${shortcode}/`, () =>
      Promise.reject(new BrowserFetchError("Not enough request time left.", "timeout"))
    );

    await expect(result).rejects.toBeInstanceOf(SocialFetchError);
    await expect(result).rejects.toMatchObject({ reason: "timeout" });
  });

  it("refuses links that are not a post without rendering anything", async () => {
    const renderPage = vi.fn(() => Promise.resolve(rendered(page(""))));

    await expect(
      fetchInstagramDocument("https://www.instagram.com/cookcreator/", renderPage)
    ).rejects.toMatchObject({ reason: "not_found" });
    expect(renderPage).not.toHaveBeenCalled();
  });
});
