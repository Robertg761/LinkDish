import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error The runtime canary script stays in .mjs; the test narrows its API locally.
import * as canaryModule from "./run-live-canary.mjs";

type LiveCanaryEntry = {
  id: string;
  kind: "recipe-webpage" | "article-blog" | "youtube";
  url: string;
  billingClientId?: string;
  billingProvider?: string;
  expectedMinimumOutcome: "success" | "needs_retry";
  expectedFinalUrlPattern?: string;
  expectedTitlePattern?: string;
};

type ValidateManifestEntry = (input: {
  entry: LiveCanaryEntry;
  preflight: {
    requestUrl: string;
    finalUrl: string | null;
    statusCode: number | null;
    title: string | null;
    timedOut: boolean;
    error: string | null;
  };
}) => {
  driftDetected: boolean;
  driftReason: string | null;
};

type PreflightEntry = (input: {
  entry: LiveCanaryEntry;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}) => Promise<{
  driftDetected: boolean;
  driftReason: string | null;
}>;

type RunLiveCanary = (input: {
  manifestPath: string;
  baseUrl?: string;
  billingClientId?: string;
  billingProvider?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}) => Promise<{
  outputPath: string;
  summary: {
    total: number;
    manifestDrift: number;
    benchmarkTotal: number;
    passed: number;
    failed: number;
    outcomeFailures: number;
  };
}>;

const validateManifestEntry = (canaryModule as { validateManifestEntry: ValidateManifestEntry })
  .validateManifestEntry;
const preflightEntry = (canaryModule as { preflightEntry: PreflightEntry }).preflightEntry;
const runLiveCanary = (canaryModule as { runLiveCanary: RunLiveCanary }).runLiveCanary;

describe("validateManifestEntry", () => {
  it("marks final URL drift distinctly", () => {
    expect(
      validateManifestEntry({
        entry: {
          id: "entry-1",
          kind: "recipe-webpage",
          url: "https://example.com/original",
          expectedMinimumOutcome: "success",
          expectedFinalUrlPattern: "example\\.com/original",
          expectedTitlePattern: "Original Page"
        },
        preflight: {
          requestUrl: "https://example.com/original",
          finalUrl: "https://example.com/other",
          statusCode: 200,
          title: "Different Page",
          timedOut: false,
          error: null
        }
      })
    ).toEqual({
      driftDetected: true,
      driftReason: "final_url_mismatch"
    });
  });
});

describe("preflightEntry", () => {
  it("marks 404 pages as manifest drift", async () => {
    const result = await preflightEntry({
      entry: {
        id: "entry-404",
        kind: "article-blog",
        url: "https://example.com/missing",
        expectedMinimumOutcome: "needs_retry"
      },
      fetchImplementation: (() =>
        Promise.resolve({
          status: 404,
          url: "https://example.com/missing",
          text: () => Promise.resolve("<html><title>Page not found</title></html>")
        })) as unknown as typeof fetch
    });

    expect(result.driftDetected).toBe(true);
    expect(result.driftReason).toBe("not_found_status");
  });
});

describe("runLiveCanary", () => {
  it("continues after timeouts and writes drift-aware artifacts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkdish-canary-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    const manifest = [
      {
        id: "recipe-ok",
        kind: "recipe-webpage",
        url: "https://example.com/recipe",
        expectedMinimumOutcome: "success",
        expectedFinalUrlPattern: "example\\.com/recipe",
        expectedTitlePattern: "Recipe"
      },
      {
        id: "article-drift",
        kind: "article-blog",
        url: "https://example.com/article",
        expectedMinimumOutcome: "needs_retry",
        expectedFinalUrlPattern: "example\\.com/article"
      }
    ];

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const fetchImplementation = ((url, init) => {
      if (typeof url === "string" && url === "https://example.com/recipe") {
        return Promise.resolve({
          status: 200,
          url,
          text: () => Promise.resolve("<html><title>Recipe</title></html>")
        });
      }

      if (typeof url === "string" && url === "https://example.com/article") {
        return Promise.resolve({
          status: 404,
          url,
          text: () => Promise.resolve("<html><title>Page not found</title></html>")
        });
      }

      if (typeof url === "string" && url.endsWith("/extract")) {
        const requestBody = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(requestBody) as { url: string; attempt: string };

        if (body.url === "https://example.com/recipe" && body.attempt === "primary") {
          return Promise.resolve({
            status: 200,
            json: () =>
              Promise.resolve({
                status: "success",
                recipe: {
                  title: "Recipe"
                }
              })
          });
        }
      }

      throw new Error(`Unexpected fetch: ${typeof url === "string" ? url : "non-string url"}`);
    }) as typeof fetch;

    const result = await runLiveCanary({
      manifestPath,
      baseUrl: "http://127.0.0.1:3000",
      timeoutMs: 100,
      fetchImplementation
    });

    const artifact = JSON.parse(await readFile(result.outputPath, "utf8")) as {
      summary: {
        total: number;
        manifestDrift: number;
        benchmarkTotal: number;
        passed: number;
        failed: number;
        outcomeFailures: number;
      };
      results: Array<{
        finalUrl: string | null;
        timedOut: boolean;
        driftDetected: boolean;
        expectedOutcomeMet: boolean;
      }>;
    };

    expect(result.summary).toMatchObject({
      total: 2,
      manifestDrift: 1,
      benchmarkTotal: 1,
      passed: 1,
      failed: 1,
      outcomeFailures: 0
    });
    expect(artifact.results[0]).toMatchObject({
      finalUrl: "https://example.com/recipe",
      timedOut: false,
      driftDetected: false,
      expectedOutcomeMet: true
    });
    expect(artifact.results[1]).toMatchObject({
      timedOut: false,
      driftDetected: true,
      expectedOutcomeMet: false
    });

    await rm(tempDir, { recursive: true, force: true });
    await rm(result.outputPath, { force: true });
  });

  it("sends canary headers and fails when the expected outcome is missed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkdish-canary-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    const manifest = [
      {
        id: "recipe-plan-limit",
        kind: "recipe-webpage",
        url: "https://example.com/recipe",
        expectedMinimumOutcome: "success",
        expectedFinalUrlPattern: "example\\.com/recipe",
        expectedTitlePattern: "Recipe"
      }
    ];
    let extractHeaders: HeadersInit | undefined;

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const fetchImplementation = ((url, init) => {
      if (typeof url === "string" && url === "https://example.com/recipe") {
        return Promise.resolve({
          status: 200,
          url,
          text: () => Promise.resolve("<html><title>Recipe</title></html>")
        });
      }

      if (typeof url === "string" && url.endsWith("/extract")) {
        extractHeaders = init?.headers;

        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              status: "failure",
              reason: "plan_limit"
            })
        });
      }

      throw new Error(`Unexpected fetch: ${typeof url === "string" ? url : "non-string url"}`);
    }) as typeof fetch;

    const result = await runLiveCanary({
      manifestPath,
      baseUrl: "https://api.example.com",
      billingClientId: "canary-user",
      billingProvider: "revenuecat",
      timeoutMs: 100,
      fetchImplementation
    });

    const artifact = JSON.parse(await readFile(result.outputPath, "utf8")) as {
      results: Array<{
        finalStatus: string;
        expectedOutcomeMet: boolean;
        outcomeFailureReason: string;
      }>;
    };

    expect(extractHeaders).toMatchObject({
      "content-type": "application/json",
      "x-linkdish-canary": "1",
      "x-linkdish-client-id": "canary-user",
      "x-linkdish-billing-provider": "revenuecat"
    });
    expect(result.summary).toMatchObject({
      total: 1,
      benchmarkTotal: 1,
      passed: 0,
      failed: 1,
      outcomeFailures: 1
    });
    expect(artifact.results[0]).toMatchObject({
      finalStatus: "failure",
      expectedOutcomeMet: false,
      outcomeFailureReason: "expected_success_got_failure"
    });

    await rm(tempDir, { recursive: true, force: true });
    await rm(result.outputPath, { force: true });
  });

  it("defaults extract requests to the live canary client id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkdish-canary-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    const manifest = [
      {
        id: "recipe-default-client",
        kind: "recipe-webpage",
        url: "https://example.com/recipe",
        expectedMinimumOutcome: "success",
        expectedFinalUrlPattern: "example\\.com/recipe",
        expectedTitlePattern: "Recipe"
      }
    ];
    let extractHeaders: HeadersInit | undefined;

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const fetchImplementation = ((url, init) => {
      if (typeof url === "string" && url === "https://example.com/recipe") {
        return Promise.resolve({
          status: 200,
          url,
          text: () => Promise.resolve("<html><title>Recipe</title></html>")
        });
      }

      if (typeof url === "string" && url.endsWith("/extract")) {
        extractHeaders = init?.headers;

        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              status: "success",
              recipe: {
                title: "Recipe"
              }
            })
        });
      }

      throw new Error(`Unexpected fetch: ${typeof url === "string" ? url : "non-string url"}`);
    }) as typeof fetch;

    const result = await runLiveCanary({
      manifestPath,
      baseUrl: "https://api.example.com",
      timeoutMs: 100,
      fetchImplementation
    });

    expect(extractHeaders).toMatchObject({
      "content-type": "application/json",
      "x-linkdish-canary": "1",
      "x-linkdish-client-id": "live-canary",
      "x-linkdish-billing-provider": "revenuecat"
    });
    expect(result.summary).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0
    });

    await rm(tempDir, { recursive: true, force: true });
    await rm(result.outputPath, { force: true });
  });

  it("lets manifest entries override the default canary client id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "linkdish-canary-"));
    const manifestPath = path.join(tempDir, "manifest.json");
    const manifest = [
      {
        id: "recipe-entry-client",
        kind: "recipe-webpage",
        url: "https://example.com/recipe",
        billingClientId: "manifest-client",
        expectedMinimumOutcome: "success",
        expectedFinalUrlPattern: "example\\.com/recipe",
        expectedTitlePattern: "Recipe"
      }
    ];
    let extractHeaders: HeadersInit | undefined;

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const fetchImplementation = ((url, init) => {
      if (typeof url === "string" && url === "https://example.com/recipe") {
        return Promise.resolve({
          status: 200,
          url,
          text: () => Promise.resolve("<html><title>Recipe</title></html>")
        });
      }

      if (typeof url === "string" && url.endsWith("/extract")) {
        extractHeaders = init?.headers;

        return Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              status: "success",
              recipe: {
                title: "Recipe"
              }
            })
        });
      }

      throw new Error(`Unexpected fetch: ${typeof url === "string" ? url : "non-string url"}`);
    }) as typeof fetch;

    const result = await runLiveCanary({
      manifestPath,
      baseUrl: "https://api.example.com",
      timeoutMs: 100,
      fetchImplementation
    });

    expect(extractHeaders).toMatchObject({
      "x-linkdish-canary": "1",
      "x-linkdish-client-id": "manifest-client",
      "x-linkdish-billing-provider": "revenuecat"
    });
    expect(result.summary.failed).toBe(0);

    await rm(tempDir, { recursive: true, force: true });
    await rm(result.outputPath, { force: true });
  });
});
