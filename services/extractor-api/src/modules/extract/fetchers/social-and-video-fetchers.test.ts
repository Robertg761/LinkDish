import { describe, expect, it, vi } from "vitest";

/* The transcript library does its own networking; these tests stay offline. */
vi.mock("youtube-transcript", () => ({
  YoutubeTranscript: { fetchTranscript: () => Promise.resolve([]) }
}));

import { SocialFetchError } from "./errors";
import { fetchTikTokDocument, TIKTOK_OEMBED_ENDPOINT } from "./fetch-tiktok-document";
import {
  extractYouTubeShortDescription,
  fetchYouTubeDocument,
  readYouTubeCommentsRequest,
  readYouTubeCreatorComments
} from "./fetch-youtube-document";

import type { ValidateSourceUrl } from "../source-url-safety";

type FetchSignature = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const redirectTo = (location: string) => new Response(null, { status: 301, headers: { location } });

const safe: ValidateSourceUrl = () => Promise.resolve({ safe: true });

const requestedUrl = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

describe("fetchTikTokDocument", () => {
  const videoUrl = "https://www.tiktok.com/@cook/video/7234567890123456789";

  it("reads the caption, author and thumbnail through oEmbed", async () => {
    const fetchMock = vi.fn<FetchSignature>(() =>
      Promise.resolve(
        json({
          title: "Chili: 1 lb beef, 1 can beans. Simmer 20 min #dinner",
          author_name: "Cook Creator",
          thumbnail_url: "https://p16-sign.tiktokcdn.com/thumb.jpeg"
        })
      )
    );

    const document = await fetchTikTokDocument(
      `${videoUrl}?is_from_webapp=1&sender_device=pc`,
      fetchMock as unknown as typeof fetch,
      { timeoutMs: 1_000, validateUrl: safe }
    );

    expect(requestedUrl(fetchMock.mock.calls[0]![0])).toBe(
      `${TIKTOK_OEMBED_ENDPOINT}?url=${encodeURIComponent(videoUrl)}`
    );
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(document).toEqual({
      kind: "text",
      url: videoUrl,
      origin: "tiktok",
      text: "Chili: 1 lb beef, 1 can beans. Simmer 20 min #dinner",
      title: null,
      authorName: "Cook Creator",
      thumbnailUrl: "https://p16-sign.tiktokcdn.com/thumb.jpeg"
    });
  });

  it("turns the runs of spaces TikTok leaves for line breaks back into line breaks", async () => {
    const fetchMock = vi.fn<FetchSignature>(() =>
      Promise.resolve(
        json({ title: "Pasta salad  Ingredients  Pasta screws cooked  Parsley  #easyrecipes " })
      )
    );

    const document = await fetchTikTokDocument(videoUrl, fetchMock as unknown as typeof fetch, {
      timeoutMs: 1_000,
      validateUrl: safe
    });

    expect(document.text).toBe(
      "Pasta salad\nIngredients\nPasta screws cooked\nParsley\n#easyrecipes"
    );
  });

  it("resolves short links one validated hop at a time", async () => {
    const validateUrl = vi.fn<ValidateSourceUrl>(() => Promise.resolve({ safe: true }));
    const fetchMock = vi.fn<FetchSignature>((input) => {
      const url = requestedUrl(input);

      if (url === "https://vm.tiktok.com/ZMabc123/") {
        return Promise.resolve(redirectTo("https://www.tiktok.com/t/ZTxyz/"));
      }

      if (url === "https://www.tiktok.com/t/ZTxyz/") {
        return Promise.resolve(redirectTo(`${videoUrl}?_r=1`));
      }

      return Promise.resolve(json({ title: "caption" }));
    });

    const document = await fetchTikTokDocument(
      "https://vm.tiktok.com/ZMabc123/",
      fetchMock as unknown as typeof fetch,
      { timeoutMs: 1_000, validateUrl }
    );

    expect(document.url).toBe(videoUrl);
    expect(validateUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://vm.tiktok.com/ZMabc123/",
      "https://www.tiktok.com/t/ZTxyz/",
      `${TIKTOK_OEMBED_ENDPOINT}?url=${encodeURIComponent(videoUrl)}`
    ]);
  });

  it("refuses short links that leave TikTok", async () => {
    const fetchMock = vi.fn<FetchSignature>(() =>
      Promise.resolve(redirectTo("http://169.254.169.254/latest/meta-data"))
    );

    await expect(
      fetchTikTokDocument("https://vm.tiktok.com/ZMabc123/", fetchMock as unknown as typeof fetch, {
        timeoutMs: 1_000,
        validateUrl: safe
      })
    ).rejects.toMatchObject({ reason: "blocked" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when URL safety rejects the link", async () => {
    const fetchMock = vi.fn<FetchSignature>();

    await expect(
      fetchTikTokDocument("https://vm.tiktok.com/ZMabc123/", fetchMock as unknown as typeof fetch, {
        timeoutMs: 1_000,
        validateUrl: () => Promise.resolve({ safe: false, reason: "private_address" })
      })
    ).rejects.toBeInstanceOf(SocialFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies oEmbed failures", async () => {
    const statusFor = async (status: number) =>
      fetchTikTokDocument(
        videoUrl,
        (() => Promise.resolve(json({}, status))) as unknown as typeof fetch,
        { timeoutMs: 1_000, validateUrl: safe }
      ).catch((error: unknown) => (error as SocialFetchError).reason);

    await expect(statusFor(404)).resolves.toBe("not_found");
    await expect(statusFor(400)).resolves.toBe("not_found");
    await expect(statusFor(429)).resolves.toBe("blocked");
    await expect(statusFor(502)).resolves.toBe("unreachable");
  });

  it("drops non-http thumbnails", async () => {
    const document = await fetchTikTokDocument(
      videoUrl,
      (() =>
        Promise.resolve(
          json({ title: "caption", thumbnail_url: "javascript:alert(1)" })
        )) as unknown as typeof fetch,
      { timeoutMs: 1_000, validateUrl: safe }
    );

    expect(document.thumbnailUrl).toBeNull();
  });

  it("times out stalled requests", async () => {
    const hanging: FetchSignature = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    await expect(
      fetchTikTokDocument(videoUrl, hanging as unknown as typeof fetch, {
        timeoutMs: 10,
        validateUrl: safe
      })
    ).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("YouTube descriptions", () => {
  const fullDescription =
    "Ingredients:\n2 cups flour\n1 cup milk\n\nMethod:\nWhisk everything and fry in a hot pan.";
  const watchPage = `<html><head><meta property="og:description" content="Ingredients: 2 cups flour..."></head><body><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ","shortDescription":${JSON.stringify(
    fullDescription
  )},"author":"Cook"}};</script></body></html>`;

  it("reads the full shortDescription instead of the truncated og:description", () => {
    expect(extractYouTubeShortDescription(watchPage)).toBe(fullDescription);
    expect(extractYouTubeShortDescription("<html></html>")).toBeNull();
    expect(
      extractYouTubeShortDescription('{"videoDetails":{"shortDescription":"unterminated')
    ).toBeNull();
  });

  it("fetches Shorts through the canonical watch page and keeps the channel name", async () => {
    const fetchMock = vi.fn<FetchSignature>((input) => {
      const url = requestedUrl(input);

      if (url.startsWith("https://www.youtube.com/oembed")) {
        return Promise.resolve(json({ title: "Crepes", author_name: "Cook Channel" }));
      }

      return Promise.resolve(
        new Response(watchPage, { status: 200, headers: { "content-type": "text/html" } })
      );
    });

    const document = await fetchYouTubeDocument(
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "dQw4w9WgXcQ",
      fetchMock as unknown as typeof fetch,
      50,
      { validateUrl: safe }
    );
    const requested = fetchMock.mock.calls.map(([input]) => requestedUrl(input));

    expect(requested).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(requested).toContain(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      )}&format=json`
    );
    expect(document).toMatchObject({
      kind: "youtube",
      url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      title: "Crepes",
      description: fullDescription,
      authorName: "Cook Channel"
    });
  });
});

describe("YouTube creator comments", () => {
  const commentsToken = "Eg0SC2NvbW1lbnRzLXNlY3Rpb24";
  const initialData = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { videoPrimaryInfoRenderer: {} },
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      continuationItemRenderer: {
                        continuationEndpoint: {
                          continuationCommand: { token: commentsToken }
                        }
                      }
                    }
                  ],
                  sectionIdentifier: "comment-item-section"
                }
              }
            ]
          }
        },
        secondaryResults: {
          continuationItemRenderer: {
            continuationEndpoint: { continuationCommand: { token: "related-videos" } }
          }
        }
      }
    }
  };
  const watchPage = `<html><body><script>ytcfg.set({"INNERTUBE_CLIENT_VERSION":"2.20261019.01.00"});</script><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ","shortDescription":""}};</script><script>var ytInitialData = ${JSON.stringify(
    initialData
  )};</script></body></html>`;
  const comment = (content: string, isCreator: boolean, replyLevel = 0) => ({
    payload: {
      commentEntityPayload: {
        properties: { content: { content }, replyLevel },
        author: { displayName: isCreator ? "@cook" : "@fan", isCreator }
      }
    }
  });
  const commentsResponse = {
    frameworkUpdates: {
      entityBatchUpdate: {
        mutations: [
          comment("Looks delicious!", false),
          comment("Gnocchi\n1. Add 1 cup cream", true),
          comment("Thanks!", true, 1)
        ]
      }
    }
  };

  it("reads the comment section's token and the client version from the watch page", () => {
    expect(readYouTubeCommentsRequest(watchPage)).toEqual({
      token: commentsToken,
      clientVersion: "2.20261019.01.00"
    });
    expect(readYouTubeCommentsRequest("<html></html>")).toBeNull();
  });

  it("keeps only the creator's own top-level comments", () => {
    expect(readYouTubeCreatorComments(commentsResponse)).toEqual(["Gnocchi\n1. Add 1 cup cream"]);
    expect(
      readYouTubeCreatorComments({
        commentRenderer: {
          authorIsChannelOwner: true,
          contentText: { runs: [{ text: "Older " }, { text: "layout" }] }
        }
      })
    ).toEqual(["Older layout"]);
  });

  it("loads the creator's comments with the video", async () => {
    const fetchMock = vi.fn<FetchSignature>((input, init) => {
      const url = requestedUrl(input);

      if (url.startsWith("https://www.youtube.com/oembed")) {
        return Promise.resolve(json({ title: "Gnocchi", author_name: "Cook" }));
      }

      if (url.startsWith("https://www.youtube.com/youtubei/v1/next")) {
        expect(JSON.parse(init?.body as string)).toMatchObject({
          context: { client: { clientName: "WEB", clientVersion: "2.20261019.01.00" } },
          continuation: commentsToken
        });
        return Promise.resolve(json(commentsResponse));
      }

      return Promise.resolve(
        new Response(watchPage, { status: 200, headers: { "content-type": "text/html" } })
      );
    });

    const document = await fetchYouTubeDocument(
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "dQw4w9WgXcQ",
      fetchMock as unknown as typeof fetch,
      50,
      { validateUrl: safe }
    );

    expect(document.creatorComments).toEqual(["Gnocchi\n1. Add 1 cup cream"]);
  });

  it("treats a failed comments request as no comments", async () => {
    const fetchMock = vi.fn<FetchSignature>((input) => {
      const url = requestedUrl(input);

      if (url.startsWith("https://www.youtube.com/oembed")) {
        return Promise.resolve(json({ title: "Gnocchi" }));
      }

      if (url.startsWith("https://www.youtube.com/youtubei/v1/next")) {
        return Promise.reject(new Error("socket hang up"));
      }

      return Promise.resolve(
        new Response(watchPage, { status: 200, headers: { "content-type": "text/html" } })
      );
    });

    const document = await fetchYouTubeDocument(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "dQw4w9WgXcQ",
      fetchMock as unknown as typeof fetch,
      50,
      { validateUrl: safe }
    );

    expect(document.creatorComments).toEqual([]);
  });
});
