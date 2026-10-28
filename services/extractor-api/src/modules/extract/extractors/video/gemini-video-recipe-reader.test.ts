import { describe, expect, it, vi } from "vitest";

import { createGeminiVideoRecipeReader } from "./gemini-video-recipe-reader";

type FetchSignature = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const requestedUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

const apiBase = "https://generativelanguage.googleapis.com";
const uploadUrl = `${apiBase}/upload/v1beta/files?upload_id=abc`;

const answer = {
  recipeInVideo: true,
  title: "Garlic Butter Noodles",
  ingredients: [{ item: "spaghetti", amount: "8 oz", source: "speech", quote: "8 oz spaghetti" }],
  steps: [{ text: "Boil the spaghetti.", source: "speech", quote: "boil the spaghetti" }]
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers }
  });

/* Gemini's Files API and generateContent; generate decides how the read itself goes. */
const geminiFetch = (generate: () => Response) =>
  vi.fn<FetchSignature>((input, init) => {
    const url = requestedUrl(input);

    if (url === `${apiBase}/upload/v1beta/files`) {
      return Promise.resolve(new Response(null, { headers: { "x-goog-upload-url": uploadUrl } }));
    }

    if (url === uploadUrl) {
      return Promise.resolve(
        json({ file: { name: "files/abc", uri: `${apiBase}/v1beta/files/abc`, state: "ACTIVE" } })
      );
    }

    if (url.endsWith(":generateContent")) {
      return Promise.resolve(generate());
    }

    if (url === `${apiBase}/v1beta/files/abc` && init?.method === "DELETE") {
      return Promise.resolve(json({}));
    }

    return Promise.reject(new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`));
  });

const readerWith = (fetchImplementation: typeof fetch) =>
  createGeminiVideoRecipeReader({
    enabled: true,
    apiKey: "test-key",
    model: "gemini-test",
    fetchImplementation,
    timeoutMs: 10_000
  });

/* Over the 14 MB inline limit, so the video goes through the Files API. */
const largeVideo = () => ({
  kind: "file" as const,
  bytes: new Uint8Array(15 * 1024 * 1024),
  mimeType: "video/mp4"
});

const context = { platform: "tiktok" as const, caption: null, title: null, authorName: null };

const deleteCalls = (fetchMock: ReturnType<typeof geminiFetch>) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "DELETE")
    .map(([input]) => requestedUrl(input));

describe("the Gemini video recipe reader", () => {
  it("uses the creation prompt only when an inspired recipe is requested", async () => {
    const fetchMock = geminiFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })
    );
    const source = { kind: "youtube" as const, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
    await readerWith(fetchMock).read({ source, context });
    await readerWith(fetchMock).read({ source, context, inspired: true });
    const calls = fetchMock.mock.calls.filter(([input]) =>
      requestedUrl(input).endsWith(":generateContent")
    );
    const first = calls[0]?.[1]?.body;
    const second = calls[1]?.[1]?.body;
    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect(first).toContain("Never add ingredients");
    expect(second).toContain("create a practical recipe inspired by that food");
    expect(second).toContain("not a transcription");
  });

  it("deletes an uploaded video once Gemini has read it", async () => {
    const fetchMock = geminiFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })
    );

    const payload = await readerWith(fetchMock).read({ source: largeVideo(), context });

    expect(payload?.title).toBe("Garlic Butter Noodles");
    expect(deleteCalls(fetchMock)).toEqual([`${apiBase}/v1beta/files/abc`]);
  });

  it("deletes an uploaded video when the read fails", async () => {
    const fetchMock = geminiFetch(() => new Response("overloaded", { status: 503 }));

    await expect(readerWith(fetchMock).read({ source: largeVideo(), context })).rejects.toThrow(
      /failed with 503/u
    );
    expect(deleteCalls(fetchMock)).toEqual([`${apiBase}/v1beta/files/abc`]);
  });

  /*
   * fetch sets content-length from the body. A second one set by hand makes the npm undici
   * that cheerio loads reject the request ("invalid content-length header") before it is sent.
   */
  it("leaves the upload's content-length to fetch", async () => {
    const fetchMock = geminiFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })
    );

    await readerWith(fetchMock).read({ source: largeVideo(), context });

    const upload = fetchMock.mock.calls.find(([input]) => requestedUrl(input) === uploadUrl);
    expect(new Headers(upload?.[1]?.headers).has("content-length")).toBe(false);
    expect((upload?.[1]?.body as Blob).size).toBe(15 * 1024 * 1024);
  });

  it("sends a small video inline, with nothing to delete", async () => {
    const fetchMock = geminiFetch(() =>
      json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })
    );

    await readerWith(fetchMock).read({
      source: { kind: "file", bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4" },
      context
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deleteCalls(fetchMock)).toEqual([]);
  });
});
