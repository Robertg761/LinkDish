import { describe, expect, it, vi } from "vitest";

import { SocialFetchError } from "./errors";
import { TIKTOK_EMBED_PAGE_ENDPOINT } from "./fetch-tiktok-document";
import { fetchTikTokVideo } from "./fetch-tiktok-video";

import type { ValidateSourceUrl } from "../source-url-safety";

type FetchSignature = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const safe: ValidateSourceUrl = () => Promise.resolve({ safe: true });

const requestedUrl = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

const videoId = "7234567890123456789";
const videoUrl = `https://www.tiktok.com/@cook/video/${videoId}`;
const mediaUrl = "https://v45.tiktokcdn-us.com/abc/video/tos/useast5/clip/?mime_type=video_mp4";

const embedPage = (video: Record<string, unknown>) =>
  new Response(
    `<html><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify({
      source: {
        data: {
          [`/embed/v2/${videoId}`]: { videoData: { itemInfos: { text: "caption", video } } }
        }
      }
    })}</script></html>`,
    { status: 200, headers: { "content-type": "text/html" } }
  );

const mp4 = (bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])) =>
  new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } });

const options = { timeoutMs: 1_000, maxBytes: 1_024, maxSeconds: 240, validateUrl: safe };

describe("fetchTikTokVideo", () => {
  it("downloads the MP4 the embed page links, with its length", async () => {
    const fetchMock = vi.fn<FetchSignature>((input) =>
      Promise.resolve(
        requestedUrl(input).startsWith(TIKTOK_EMBED_PAGE_ENDPOINT)
          ? embedPage({ urls: [mediaUrl], videoMeta: { duration: 42 } })
          : mp4()
      )
    );

    const video = await fetchTikTokVideo(videoUrl, fetchMock, options);

    expect(fetchMock.mock.calls.map(([input]) => requestedUrl(input))).toEqual([
      `${TIKTOK_EMBED_PAGE_ENDPOINT}/${videoId}`,
      mediaUrl
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.redirect).toBe("manual");
    expect(video).toMatchObject({ mimeType: "video/mp4", durationSeconds: 42 });
    expect(video.bytes.byteLength).toBe(8);
  });

  it("refuses a video link outside TikTok's media hosts, before fetching it", async () => {
    const fetchMock = vi.fn<FetchSignature>(() =>
      Promise.resolve(embedPage({ urls: ["https://evil.example/video.mp4"] }))
    );

    await expect(fetchTikTokVideo(videoUrl, fetchMock, options)).rejects.toMatchObject({
      reason: "blocked"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks every redirect hop of the download", async () => {
    const fetchMock = vi.fn<FetchSignature>((input) => {
      const url = requestedUrl(input);

      return Promise.resolve(
        url.startsWith(TIKTOK_EMBED_PAGE_ENDPOINT)
          ? embedPage({ urls: [mediaUrl] })
          : new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
      );
    });

    await expect(fetchTikTokVideo(videoUrl, fetchMock, options)).rejects.toBeInstanceOf(
      SocialFetchError
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not download a video longer than the limit", async () => {
    const fetchMock = vi.fn<FetchSignature>(() =>
      Promise.resolve(embedPage({ urls: [mediaUrl], videoMeta: { duration: 600 } }))
    );

    await expect(fetchTikTokVideo(videoUrl, fetchMock, options)).rejects.toMatchObject({
      reason: "too_large"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops a download past the byte cap", async () => {
    const fetchMock = vi.fn<FetchSignature>((input) =>
      Promise.resolve(
        requestedUrl(input).startsWith(TIKTOK_EMBED_PAGE_ENDPOINT)
          ? embedPage({ urls: [mediaUrl] })
          : mp4(new Uint8Array(2_048))
      )
    );

    await expect(fetchTikTokVideo(videoUrl, fetchMock, options)).rejects.toMatchObject({
      reason: "too_large"
    });
  });

  it("reports a post with no playable video as not found", async () => {
    const fetchMock = vi.fn<FetchSignature>(() => Promise.resolve(embedPage({})));

    await expect(fetchTikTokVideo(videoUrl, fetchMock, options)).rejects.toMatchObject({
      reason: "not_found"
    });
  });

  it("refuses a non-video response", async () => {
    const fetchMock = vi.fn<FetchSignature>((input) =>
      Promise.resolve(
        requestedUrl(input).startsWith(TIKTOK_EMBED_PAGE_ENDPOINT)
          ? embedPage({ urls: [mediaUrl] })
          : new Response("<html></html>", { headers: { "content-type": "text/html" } })
      )
    );

    await expect(fetchTikTokVideo(videoUrl, fetchMock, options)).rejects.toMatchObject({
      reason: "unsupported_content_type"
    });
  });
  it("downloads the MP4 the caption fetch already found, without the embed page", async () => {
    const fetchMock = vi.fn<FetchSignature>(() => Promise.resolve(mp4()));

    const video = await fetchTikTokVideo(videoUrl, fetchMock, {
      ...options,
      locator: { videoId, mediaUrl, durationSeconds: 42 }
    });

    expect(fetchMock.mock.calls.map(([input]) => requestedUrl(input))).toEqual([mediaUrl]);
    expect(video.durationSeconds).toBe(42);
  });

  it("uses the video id the caption fetch found when the link does not name one", async () => {
    const fetchMock = vi.fn<FetchSignature>((input) =>
      Promise.resolve(
        requestedUrl(input).startsWith(TIKTOK_EMBED_PAGE_ENDPOINT)
          ? embedPage({ urls: [mediaUrl] })
          : mp4()
      )
    );

    await fetchTikTokVideo("https://www.tiktok.com/@cook", fetchMock, {
      ...options,
      locator: { videoId, mediaUrl: null, durationSeconds: null }
    });

    expect(requestedUrl(fetchMock.mock.calls[0]![0])).toBe(
      `${TIKTOK_EMBED_PAGE_ENDPOINT}/${videoId}`
    );
  });
});
