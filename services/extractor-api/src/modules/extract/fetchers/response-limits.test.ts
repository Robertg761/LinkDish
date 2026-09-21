import { describe, expect, it, vi } from "vitest";

import { fetchHtmlDocument } from "./fetch-html-document";
import { fetchYouTubeDocument } from "./fetch-youtube-document";
import { isHtmlLikeContentType, readLimitedResponseText } from "./shared";

import type { ValidateSourceUrl } from "../source-url-safety";

const allowUrl: ValidateSourceUrl = () => Promise.resolve({ safe: true });

const createStreamingResponse = ({
  totalBytes,
  chunkBytes = 8 * 1024,
  contentType = "text/html",
  status = 200,
  contentLength
}: {
  totalBytes: number;
  chunkBytes?: number;
  contentType?: string | null;
  status?: number;
  contentLength?: number;
}): Response => {
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= totalBytes) {
        controller.close();
        return;
      }

      const size = Math.min(chunkBytes, totalBytes - emitted);
      emitted += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    }
  });

  return new Response(stream, {
    status,
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) })
    }
  });
};


const requestUrlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
};

describe("readLimitedResponseText", () => {
  it("aborts a streamed body once it passes the byte cap", async () => {
    const response = createStreamingResponse({ totalBytes: 256 * 1024 });

    await expect(readLimitedResponseText(response, 1_024)).rejects.toThrow(/exceeded/iu);
  });

  it("rejects before reading when content-length already exceeds the cap", async () => {
    const response = createStreamingResponse({
      totalBytes: 64,
      contentLength: 50_000_000
    });

    await expect(readLimitedResponseText(response, 1_024)).rejects.toThrow(/exceeded/iu);
    expect(response.bodyUsed).toBe(false);
  });

  it("returns the full body when it is under the cap", async () => {
    const response = new Response("<html><body>ok</body></html>", {
      headers: { "content-type": "text/html" }
    });

    await expect(readLimitedResponseText(response, 1_024)).resolves.toBe(
      "<html><body>ok</body></html>"
    );
  });

  it("still works for responses without a readable stream body", async () => {
    const response = {
      headers: new Headers({ "content-type": "text/html" }),
      text: () => Promise.resolve("<html>legacy</html>")
    } as unknown as Response;

    await expect(readLimitedResponseText(response, 1_024)).resolves.toBe("<html>legacy</html>");
    await expect(readLimitedResponseText(response, 4)).rejects.toThrow(/exceeded/iu);
  });
});

describe("isHtmlLikeContentType", () => {
  it("accepts html-ish and missing content types", () => {
    for (const value of [
      null,
      "",
      "text/html",
      "text/html; charset=utf-8",
      "TEXT/HTML",
      "application/xhtml+xml",
      "text/plain",
      "application/xml"
    ]) {
      expect(isHtmlLikeContentType(value)).toBe(true);
    }
  });

  it("rejects binary and non-document content types", () => {
    for (const value of [
      "application/pdf",
      "application/octet-stream",
      "image/png",
      "video/mp4",
      "application/zip"
    ]) {
      expect(isHtmlLikeContentType(value)).toBe(false);
    }
  });
});

describe("fetchHtmlDocument response limits", () => {
  it("rejects a body that exceeds the configured byte cap", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      createStreamingResponse({
        totalBytes: 256 * 1024
      })
    ) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/huge", fetchImplementation, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 2,
        maxBytes: 1_024
      })
    ).rejects.toMatchObject({
      reason: "too_large"
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-HTML content type without buffering the body", async () => {
    const response = createStreamingResponse({
      totalBytes: 256 * 1024,
      contentType: "application/pdf"
    });
    const fetchImplementation = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/report.pdf", fetchImplementation, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 0
      })
    ).rejects.toMatchObject({
      reason: "unsupported_content_type"
    });
    expect(response.bodyUsed).toBe(false);
  });

  it("keeps classifying blocked status codes even for non-HTML bodies", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      createStreamingResponse({
        totalBytes: 64,
        contentType: "application/json",
        status: 403
      })
    ) as unknown as typeof fetch;

    await expect(
      fetchHtmlDocument("https://example.com/blocked", fetchImplementation, {
        validateUrl: allowUrl,
        timeoutMs: 1_000,
        retries: 0
      })
    ).rejects.toMatchObject({
      reason: "blocked",
      statusCode: 403
    });
  });

  it("still returns documents that fit inside the cap", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response("<html><head><title>Small</title></head><body>hi</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })
    ) as unknown as typeof fetch;

    const result = await fetchHtmlDocument("https://example.com/small", fetchImplementation, {
      validateUrl: allowUrl,
      timeoutMs: 1_000,
      retries: 0,
      maxBytes: 1_024
    });

    expect(result.document.title).toBe("Small");
  });
});

describe("fetchYouTubeDocument safety", () => {
  const oEmbedResponse = () =>
    new Response(JSON.stringify({ title: "Video", author_name: "Chef" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

  const watchPage = (captionBaseUrl: string) =>
    new Response(
      `<html><head><title>Video</title></head><body><script>{"captionTracks":[{"baseUrl":"${captionBaseUrl}"}]}</script></body></html>`,
      {
        status: 200,
        headers: { "content-type": "text/html" }
      }
    );

  it("refuses to fetch a caption track that fails source URL validation", async () => {
    const captionUrl = "http://169.254.169.254/latest/meta-data";
    const fetchImplementation = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = requestUrlOf(input);

      if (requestUrl.includes("oembed")) {
        return Promise.resolve(oEmbedResponse());
      }

      if (requestUrl.includes("watch")) {
        return Promise.resolve(watchPage(captionUrl));
      }

      return Promise.resolve(
        new Response("<transcript><text>secret</text></transcript>", {
          status: 200,
          headers: { "content-type": "text/xml" }
        })
      );
    }) as unknown as typeof fetch;

    const document = await fetchYouTubeDocument(
      "https://www.youtube.com/watch?v=abc123",
      "abc123",
      fetchImplementation,
      1_000,
      {
        validateUrl: (candidate) =>
          Promise.resolve(
            candidate.includes("169.254.169.254")
              ? { reason: "private_address", safe: false }
              : { safe: true }
          )
      }
    );

    expect(document.transcript).toBeNull();
    expect(
      (fetchImplementation as unknown as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
        requestUrlOf(call[0] as RequestInfo | URL).includes("169.254.169.254")
      )
    ).toBe(false);
  });

  it("rejects an oversized watch page instead of buffering it", async () => {
    const fetchImplementation = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = requestUrlOf(input);

      if (requestUrl.includes("oembed")) {
        return Promise.resolve(oEmbedResponse());
      }

      return Promise.resolve(createStreamingResponse({ totalBytes: 256 * 1024 }));
    }) as unknown as typeof fetch;

    await expect(
      fetchYouTubeDocument(
        "https://www.youtube.com/watch?v=abc123",
        "abc123",
        fetchImplementation,
        1_000,
        {
          maxBytes: 1_024,
          validateUrl: allowUrl
        }
      )
    ).rejects.toMatchObject({
      reason: "too_large"
    });
  });
});
