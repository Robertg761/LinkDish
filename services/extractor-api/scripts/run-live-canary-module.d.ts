declare module "./run-live-canary.mjs" {
  export type LiveCanaryEntry = {
    id: string;
    kind: "recipe-webpage" | "article-blog" | "youtube";
    url: string;
    billingClientId?: string;
    billingProvider?: string;
    expectedMinimumOutcome: "success" | "needs_retry";
    expectedFinalUrlPattern?: string;
    expectedTitlePattern?: string;
    notes?: string;
  };

  export type LiveCanaryPreflightResult = {
    requestUrl: string;
    finalUrl: string | null;
    statusCode: number | null;
    title: string | null;
    timedOut: boolean;
    error: string | null;
    driftDetected: boolean;
    driftReason: string | null;
  };

  export type LiveCanaryAttemptResult = {
    httpStatusCode: number | null;
    timedOut: boolean;
    payload: unknown;
    error?: string;
  };

  export type LiveCanarySummary = {
    total: number;
    manifestDrift: number;
    benchmarkTotal: number;
    passed: number;
    failed: number;
    outcomeFailures: number;
    driftReasons: Record<string, number>;
    outcomeFailureReasons: Record<string, number>;
    primary: Record<string, number>;
    fallback: Record<string, number>;
    final: Record<string, number>;
  };

  export function validateManifestEntry(input: {
    entry: LiveCanaryEntry;
    preflight: Pick<
      LiveCanaryPreflightResult,
      "requestUrl" | "finalUrl" | "statusCode" | "title" | "timedOut" | "error"
    >;
  }): {
    driftDetected: boolean;
    driftReason: string | null;
  };

  export function preflightEntry(input: {
    entry: LiveCanaryEntry;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }): Promise<LiveCanaryPreflightResult>;

  export function resolveCanaryTimeoutMs(rawTimeoutMs?: string): number;

  export function runLiveCanary(input: {
    manifestPath: string;
    baseUrl?: string;
    billingClientId?: string;
    billingProvider?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }): Promise<{
    outputPath: string;
    summary: LiveCanarySummary;
  }>;

  export function main(argv?: string[]): Promise<void>;
}
