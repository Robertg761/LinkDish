import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryCacheStore, type CacheStore } from "./cache-store";
import {
  createExtractionResultCache,
  EXTRACTOR_CACHE_VERSION,
  getExtractionCacheKey
} from "./extraction-cache";

import type { ExtractRecipeResponse } from "../../../../../../packages/api-contracts/src/index.js";

const successResponse = (
  overrides: { confidenceScore?: number; sourceType?: "recipe-webpage" | "image" } = {}
): ExtractRecipeResponse => ({
  status: "success",
  recipe: {
    title: "One-Pan Tomato Pasta",
    sourceUrl: "https://example.com/pasta?utm_source=first-user",
    sourceType: overrides.sourceType ?? "recipe-webpage",
    image: null,
    ingredients: [{ text: "12 oz spaghetti", section: null }],
    steps: [{ index: 1, text: "Boil the pasta." }],
    servings: "4 servings",
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    nutrition: null,
    confidence: {
      score: overrides.confidenceScore ?? 0.92,
      summary: "Structured recipe evidence was detected.",
      missingFields: [],
      notes: [],
      fieldProvenance: {
        title: "jsonld",
        ingredients: "jsonld",
        steps: "jsonld",
        servings: "jsonld",
        prepTimeMinutes: "jsonld",
        cookTimeMinutes: "jsonld",
        nutrition: null
      }
    }
  },
  extraction: {
    sourceType: overrides.sourceType ?? "recipe-webpage",
    strategy: "recipe-schema",
    confidenceScore: overrides.confidenceScore ?? 0.92,
    missingFields: [],
    warnings: [],
    fetchMode: "http",
    provenance: ["jsonld"]
  }
});

const writeInput = (response: ExtractRecipeResponse, finalUrl = "https://example.com/pasta") => ({
  response,
  requestUrl: "https://example.com/pasta?utm_source=first-user",
  finalUrl,
  statusCode: 200,
  detectionConfidence: "high" as const
});

afterEach(() => {
  vi.useRealTimers();
});

/** Escapes every RegExp syntax character (backslash included) so `value` matches literally. */
const escapeRegExp = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");

describe("extraction result cache", () => {
  it("versions keys and shares one entry across tracking-parameter variants", () => {
    const key = getExtractionCacheKey("https://example.com/pasta/?utm_medium=email#top");

    expect(key).toMatch(
      new RegExp(
        `^linkdish:extract-cache:v1:${escapeRegExp(EXTRACTOR_CACHE_VERSION)}:[0-9a-f]{64}$`
      )
    );
    expect(key).toBe(getExtractionCacheKey("https://EXAMPLE.com/pasta"));
    expect(key).not.toBe(getExtractionCacheKey("https://example.com/pasta?page=2"));
  });

  it("escapes every RegExp character of the version, backslashes included", () => {
    const version = String.raw`2026\.09.28+rc(1)[a]{2}|^$*?`;
    const pattern = new RegExp(`^${escapeRegExp(version)}$`);

    expect(pattern.test(version)).toBe(true);
    expect(pattern.test(String.raw`2026\x09.28+rc(1)[a]{2}|^$*?`)).toBe(false);
    expect(pattern.test("2026.09.28+rc(1)[a]{2}|^$*?")).toBe(false);
  });

  it("stores validated successes and reads them back for another URL variant", async () => {
    const cache = createExtractionResultCache({
      ttlSeconds: 60,
      store: createMemoryCacheStore(10)
    });

    await expect(cache.write(writeInput(successResponse()))).resolves.toBeNull();

    const cached = await cache.read("https://example.com/pasta/?fbclid=someone-else");

    expect(cached).toMatchObject({
      detectionConfidence: "high",
      finalUrl: "https://example.com/pasta",
      statusCode: 200,
      response: {
        status: "success",
        recipe: { title: "One-Pan Tomato Pasta" }
      }
    });
  });

  it("never stores needs_retry, failures, low-confidence successes or image scans", async () => {
    const store = createMemoryCacheStore(10);
    const setSpy = vi.spyOn(store, "set");
    const cache = createExtractionResultCache({ ttlSeconds: 60, store });

    await expect(
      cache.write(
        writeInput({
          status: "needs_retry",
          reason: "low_confidence",
          sourceType: "recipe-webpage",
          suggestedAttempt: "fallback",
          userMessage: "Not reliable enough yet.",
          diagnostics: { confidenceScore: 0.6, missingFields: [] }
        })
      )
    ).resolves.toBe("not_success");
    await expect(
      cache.write(
        writeInput({
          status: "failure",
          reason: "timeout",
          userMessage: "That source took too long to respond."
        })
      )
    ).resolves.toBe("not_success");
    await expect(cache.write(writeInput(successResponse({ confidenceScore: 0.7 })))).resolves.toBe(
      "below_confidence_threshold"
    );
    await expect(cache.write(writeInput(successResponse({ sourceType: "image" })))).resolves.toBe(
      "unsupported_source_type"
    );
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("never stores or serves LLM output, which another caller could have steered", async () => {
    const values = new Map<string, string>();
    const store: CacheStore = {
      get: (key) => Promise.resolve(values.get(key) ?? null),
      set: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      }
    };
    const cache = createExtractionResultCache({ ttlSeconds: 60, store });
    const deterministic = successResponse();
    const llmResponse: ExtractRecipeResponse =
      deterministic.status === "success"
        ? {
            ...deterministic,
            recipe: { ...deterministic.recipe, title: "LLM Output Title" },
            extraction: {
              ...deterministic.extraction,
              strategy: "llm-fallback",
              provenance: ["llm"]
            }
          }
        : deterministic;

    await expect(cache.write(writeInput(llmResponse))).resolves.toBe("llm_derived");
    expect(values.size).toBe(0);

    /* An LLM entry already in the store (e.g. written by an older release) is a miss. */
    values.set(
      getExtractionCacheKey("https://example.com/pasta"),
      JSON.stringify({ v: 1, detectionConfidence: "high", response: llmResponse })
    );
    await expect(cache.read("https://example.com/pasta")).resolves.toBeNull();
  });

  it("refuses to cache a page that redirected to another site", async () => {
    const store = createMemoryCacheStore(10);
    const cache = createExtractionResultCache({ ttlSeconds: 60, store });

    await expect(
      cache.write(writeInput(successResponse(), "https://attacker.test/fake-pasta"))
    ).resolves.toBe("cross_site_redirect");
    await expect(cache.read("https://example.com/pasta")).resolves.toBeNull();

    await expect(
      cache.write(writeInput(successResponse(), "https://www.example.com/pasta"))
    ).resolves.toBeNull();
  });

  it("expires entries after the TTL", async () => {
    vi.useFakeTimers();
    const cache = createExtractionResultCache({
      ttlSeconds: 60,
      store: createMemoryCacheStore(10)
    });

    await cache.write(writeInput(successResponse()));
    vi.advanceTimersByTime(61_000);

    await expect(cache.read("https://example.com/pasta")).resolves.toBeNull();
  });

  it("treats corrupted or foreign entries as misses", async () => {
    const values = new Map<string, string>();
    const store: CacheStore = {
      get: (key) => Promise.resolve(values.get(key) ?? null),
      set: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      }
    };
    const cache = createExtractionResultCache({ ttlSeconds: 60, store });
    const key = getExtractionCacheKey("https://example.com/pasta");

    values.set(key, "not json");
    await expect(cache.read("https://example.com/pasta")).resolves.toBeNull();

    values.set(key, JSON.stringify({ v: 1, detectionConfidence: "high", response: { bad: 1 } }));
    await expect(cache.read("https://example.com/pasta")).resolves.toBeNull();
  });
});
