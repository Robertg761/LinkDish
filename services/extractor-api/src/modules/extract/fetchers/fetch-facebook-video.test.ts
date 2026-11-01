import { describe, expect, it, vi } from "vitest";

import { SocialFetchError } from "./errors";
import { fetchFacebookVideo } from "./fetch-facebook-video";

const mediaUrl = "https://video-ord5-2.xx.fbcdn.net/o1/v/t2/f2/m86/reel-sd.mp4?efg=abc";
const locator = { videoId: "900000000000001", mediaUrl, durationSeconds: 24 };
const safe = () => Promise.resolve({ safe: true as const });
const options = { timeoutMs: 5_000, maxBytes: 1_000, maxSeconds: 240, validateUrl: safe };
const video = (bytes = 3) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "video/mp4" } });

describe("fetchFacebookVideo", () => {
  it("downloads the MP4 from Facebook's CDN", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() => Promise.resolve(video()));

    const file = await fetchFacebookVideo(locator, fetchImplementation, options);

    expect(file).toMatchObject({ mimeType: "video/mp4", durationSeconds: 24 });
    expect(file.bytes.byteLength).toBe(3);
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(mediaUrl);
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses links and redirects off fbcdn.net", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://evil.example/x.mp4" } })
      )
    );

    await expect(fetchFacebookVideo(locator, fetchImplementation, options)).rejects.toMatchObject({
      reason: "blocked"
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const never = vi.fn<typeof fetch>();
    await expect(
      fetchFacebookVideo({ ...locator, mediaUrl: "https://evil.example/x.mp4" }, never, options)
    ).rejects.toBeInstanceOf(SocialFetchError);
    expect(never).not.toHaveBeenCalled();
  });

  it("refuses a video that is too long or too large", async () => {
    const never = vi.fn<typeof fetch>();
    await expect(
      fetchFacebookVideo({ ...locator, durationSeconds: 600 }, never, options)
    ).rejects.toMatchObject({ reason: "too_large" });
    expect(never).not.toHaveBeenCalled();

    await expect(
      fetchFacebookVideo(locator, () => Promise.resolve(video(5_000)), options)
    ).rejects.toMatchObject({ reason: "too_large" });
  });
});
