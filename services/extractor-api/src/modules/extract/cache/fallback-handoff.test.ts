import { describe, expect, it } from "vitest";

import { createMemoryCacheStore } from "./cache-store";
import {
  createFallbackHandoffStore,
  getFallbackHandoffKey,
  maxFallbackHandoffBytes,
  toHandoffSourceDocument,
  type FallbackHandoff
} from "./fallback-handoff";

const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";

const handoff = (overrides: Partial<FallbackHandoff> = {}): FallbackHandoff => ({
  url: "https://example.com/soup?utm_source=newsletter",
  detection: {
    sourceType: "article",
    confidence: "low",
    reasons: ["Fell back to article classification after URL heuristics."],
    adapterKey: null
  },
  fetchMode: "browser",
  candidate: null,
  sourceDocument: toHandoffSourceDocument({
    kind: "html",
    url: "https://example.com/soup",
    finalUrl: "https://www.example.com/soup",
    html: "<html><body>A very long page</body></html>",
    contentType: "text/html",
    title: "Soup",
    description: null,
    blockedSignals: ["challenge-title"],
    statusCode: 200
  }),
  sourceSummary: "Page title: Soup",
  ...overrides
});

describe("fallback hand-off store", () => {
  it("keys entries by correlation id and canonical URL", () => {
    expect(getFallbackHandoffKey(correlationId, "https://example.com/soup/#x")).toBe(
      getFallbackHandoffKey(correlationId, "https://example.com/soup?utm_source=newsletter")
    );
    expect(getFallbackHandoffKey(correlationId, "https://example.com/soup")).not.toBe(
      getFallbackHandoffKey("00000000-0000-4000-8000-000000000000", "https://example.com/soup")
    );
  });

  it("round-trips what the fallback attempt needs without the raw HTML", async () => {
    const store = createFallbackHandoffStore({ store: createMemoryCacheStore(10) });

    await expect(store.write(correlationId, "https://example.com/soup", handoff())).resolves.toBe(
      true
    );

    const stored = await store.read(correlationId, "https://example.com/soup/");

    expect(stored).toMatchObject({
      fetchMode: "browser",
      sourceSummary: "Page title: Soup",
      sourceDocument: {
        kind: "html",
        html: "",
        finalUrl: "https://www.example.com/soup",
        blockedSignals: ["challenge-title"]
      }
    });
    await expect(store.read(correlationId, "https://example.com/other")).resolves.toBeNull();
    await expect(
      store.read("00000000-0000-4000-8000-000000000000", "https://example.com/soup")
    ).resolves.toBeNull();
  });

  it("skips entries that are too large to hand off", async () => {
    const store = createFallbackHandoffStore({ store: createMemoryCacheStore(10) });

    await expect(
      store.write(
        correlationId,
        "https://example.com/soup",
        handoff({ sourceSummary: "x".repeat(maxFallbackHandoffBytes) })
      )
    ).resolves.toBe(false);
    await expect(store.read(correlationId, "https://example.com/soup")).resolves.toBeNull();
  });

  it("drops the watch page from YouTube documents but keeps the transcript", () => {
    expect(
      toHandoffSourceDocument({
        kind: "youtube",
        url: "https://www.youtube.com/watch?v=abc",
        videoId: "abc",
        title: "Video",
        description: null,
        transcript: "Add the garlic.",
        chapters: [],
        pageHtml: "<html>huge</html>"
      })
    ).toMatchObject({ pageHtml: null, transcript: "Add the garlic." });
  });
});
