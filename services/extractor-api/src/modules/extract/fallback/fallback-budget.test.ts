import { afterEach, describe, expect, it, vi } from "vitest";

const openAiMocks = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  create: vi.fn(),
  moduleLoads: 0
}));

vi.mock("openai", () => {
  openAiMocks.moduleLoads += 1;

  return {
    default: class MockOpenAI {
      public readonly responses = { create: openAiMocks.create };

      public constructor(options: unknown) {
        openAiMocks.constructorOptions.push(options);
      }
    }
  };
});

import { FallbackProviderError } from "./errors";
import { createGeminiFallbackExtractor } from "./gemini-fallback-extractor";
import { createOpenAiFallbackExtractor } from "./openai-fallback-extractor";

import type { RequestDeadline } from "../deadline";
import type { FallbackExtractionInput } from "../types";

const createDeadline = (remainingMs: number): RequestDeadline => ({
  signal: new AbortController().signal,
  expiresAt: Date.now() + remainingMs,
  remainingMs: () => remainingMs,
  budgetMs: (preferredMs, reserveMs = 0) =>
    Math.max(0, Math.min(preferredMs, remainingMs - reserveMs)),
  dispose: () => undefined
});

const input = (deadline?: RequestDeadline): FallbackExtractionInput => ({
  url: "https://example.com/soup",
  sourceType: "article",
  sourceDocument: {
    kind: "html",
    url: "https://example.com/soup",
    finalUrl: "https://example.com/soup",
    html: "<html><title>Soup</title><body><p>Simmer the soup.</p></body></html>",
    contentType: "text/html",
    title: "Soup",
    description: null,
    blockedSignals: [],
    statusCode: 200
  },
  candidate: null,
  detection: { sourceType: "article", confidence: "low", reasons: [], adapterKey: null },
  fetchMode: "http",
  ...(deadline ? { deadline } : {})
});

/* A well-formed reply that fails the recipe schema, which makes Gemini try again. */
const invalidRecipeReply = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":""}' }] } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );

afterEach(() => {
  vi.clearAllMocks();
});

describe("Gemini fallback request budget", () => {
  const createExtractor = (fetchImplementation: typeof fetch) =>
    createGeminiFallbackExtractor({
      apiKey: "gemini-key",
      model: "gemini-test",
      fetchImplementation,
      timeoutMs: 30_000
    });

  it("keeps its two attempts when no deadline applies", async () => {
    const fetchImplementation = vi.fn(invalidRecipeReply) as unknown as typeof fetch;

    await expect(createExtractor(fetchImplementation).extract(input())).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("skips the second attempt when too little of the request is left for it", async () => {
    const fetchImplementation = vi.fn(invalidRecipeReply) as unknown as typeof fetch;

    await expect(
      createExtractor(fetchImplementation).extract(input(createDeadline(6_000)))
    ).resolves.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("refuses to start when the request deadline is effectively spent", async () => {
    const fetchImplementation = vi.fn(invalidRecipeReply) as unknown as typeof fetch;

    await expect(
      createExtractor(fetchImplementation).extract(input(createDeadline(1_000)))
    ).rejects.toBeInstanceOf(FallbackProviderError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("OpenAI fallback client", () => {
  it("loads the SDK lazily and bounds each call by the timeout and the deadline", async () => {
    openAiMocks.create.mockResolvedValue({ output_text: "" });
    const extractor = createOpenAiFallbackExtractor("openai-key", "gpt-test", {
      timeoutMs: 20_000
    });

    expect(extractor.available).toBe(true);
    expect(openAiMocks.moduleLoads).toBe(0);

    const deadline = createDeadline(12_000);
    await expect(extractor.extract(input(deadline))).resolves.toBeNull();

    expect(openAiMocks.moduleLoads).toBe(1);
    expect(openAiMocks.constructorOptions).toEqual([
      { apiKey: "openai-key", maxRetries: 0, timeout: 20_000 }
    ]);
    expect(openAiMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-test" }),
      { maxRetries: 0, timeout: 10_500, signal: deadline.signal }
    );
  });
});
