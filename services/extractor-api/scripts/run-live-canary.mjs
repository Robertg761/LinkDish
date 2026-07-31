import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultTimeoutMs = 20_000;
const outcomeRank = {
  failure: 0,
  needs_retry: 1,
  success: 2
};
const browserLikeHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
};

const extractTitle = (html) => {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? null;
};

const withTimeout = async (work, timeoutMs) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
};

const toTimedOutFailure = (userMessage) => ({
  status: "failure",
  reason: "timeout",
  userMessage
});

const buildRegex = (pattern) => (pattern ? new RegExp(pattern, "i") : null);
const blockedStatusCodes = new Set([401, 402, 403, 429, 451]);

const resolveCanaryBaseUrl = () =>
  process.env.LINKDISH_CANARY_BASE_URL ??
  process.env.LINKDISH_PRODUCTION_API_BASE_URL ??
  "http://127.0.0.1:3000";

const buildExtractHeaders = ({ billingClientId, billingProvider, headers = {} }) => {
  const resolvedBillingClientId = billingClientId?.trim() || "live-canary";

  const extractHeaders = {
    "content-type": "application/json",
    ...headers,
    "x-linkdish-canary": "1",
    "x-linkdish-client-id": resolvedBillingClientId,
    "x-linkdish-billing-provider": billingProvider?.trim() || "revenuecat"
  };

  if (process.env.LINKDISH_CANARY_AUTH_TOKEN) {
    extractHeaders.authorization = `Bearer ${process.env.LINKDISH_CANARY_AUTH_TOKEN}`;
  }

  return extractHeaders;
};

const getAttemptStatus = (attempt) => {
  const status = attempt?.payload?.status;
  return typeof status === "string" ? status : null;
};

const validateExpectedOutcome = ({ expectedMinimumOutcome, finalStatus, driftDetected }) => {
  if (driftDetected) {
    return {
      expectedOutcomeMet: false,
      outcomeFailureReason: "manifest_drift"
    };
  }

  const expectedRank = outcomeRank[expectedMinimumOutcome];
  const finalRank = finalStatus ? outcomeRank[finalStatus] : undefined;

  if (expectedRank == null) {
    return {
      expectedOutcomeMet: false,
      outcomeFailureReason: "unknown_expected_outcome"
    };
  }

  if (finalRank == null || finalRank < expectedRank) {
    return {
      expectedOutcomeMet: false,
      outcomeFailureReason: `expected_${expectedMinimumOutcome}_got_${finalStatus ?? "none"}`
    };
  }

  return {
    expectedOutcomeMet: true,
    outcomeFailureReason: null
  };
};

export const validateManifestEntry = ({ entry, preflight }) => {
  if (preflight.timedOut || preflight.error) {
    return {
      driftDetected: false,
      driftReason: null
    };
  }

  if (preflight.statusCode != null && blockedStatusCodes.has(preflight.statusCode)) {
    return {
      driftDetected: false,
      driftReason: null
    };
  }

  if (preflight.statusCode === 404 || preflight.statusCode === 410) {
    return {
      driftDetected: true,
      driftReason: "not_found_status"
    };
  }

  if (/\bpage not found\b|\bnot found\b|\b404\b/i.test(preflight.title ?? "")) {
    return {
      driftDetected: true,
      driftReason: "not_found_title"
    };
  }

  const finalUrlPattern = buildRegex(entry.expectedFinalUrlPattern);
  const titlePattern = buildRegex(entry.expectedTitlePattern);
  const finalUrlMatches = finalUrlPattern ? finalUrlPattern.test(preflight.finalUrl ?? "") : true;
  const titleMatches = titlePattern ? titlePattern.test(preflight.title ?? "") : true;

  if (!finalUrlMatches && !titleMatches) {
    return {
      driftDetected: true,
      driftReason: "final_url_mismatch"
    };
  }

  if (!titleMatches) {
    return {
      driftDetected: true,
      driftReason: "title_mismatch"
    };
  }

  return {
    driftDetected: false,
    driftReason: null
  };
};

export const preflightEntry = async ({
  entry,
  timeoutMs = defaultTimeoutMs,
  fetchImplementation = fetch
}) => {
  try {
    const response = await withTimeout(
      (signal) =>
        fetchImplementation(entry.url, {
          headers: browserLikeHeaders,
          redirect: "follow",
          signal
        }),
      timeoutMs
    );
    const html = await response.text();
    const title = extractTitle(html);
    const validation = validateManifestEntry({
      entry,
      preflight: {
        requestUrl: entry.url,
        finalUrl: response.url || entry.url,
        statusCode: response.status,
        title,
        timedOut: false,
        error: null
      }
    });

    return {
      requestUrl: entry.url,
      finalUrl: response.url || entry.url,
      statusCode: response.status,
      title,
      timedOut: false,
      error: null,
      ...validation
    };
  } catch (error) {
    return {
      requestUrl: entry.url,
      finalUrl: null,
      statusCode: null,
      title: null,
      timedOut: error instanceof Error && error.name === "AbortError",
      error: error instanceof Error ? error.message : "Preflight failed.",
      driftDetected: false,
      driftReason: null
    };
  }
};

const invokeExtractAttempt = async ({
  baseUrl,
  url,
  attempt,
  headers,
  timeoutMs = defaultTimeoutMs,
  fetchImplementation = fetch
}) => {
  try {
    const response = await withTimeout(
      (signal) =>
        fetchImplementation(`${baseUrl}/extract`, {
          method: "POST",
          headers,
          body: JSON.stringify({ url, attempt }),
          signal
        }),
      timeoutMs
    );
    const payload = await response.json();

    return {
      httpStatusCode: response.status,
      timedOut: false,
      payload
    };
  } catch (error) {
    return {
      httpStatusCode: null,
      timedOut: error instanceof Error && error.name === "AbortError",
      payload: toTimedOutFailure(
        attempt === "primary"
          ? "Primary extraction timed out during the live canary."
          : "Fallback extraction timed out during the live canary."
      ),
      error: error instanceof Error ? error.message : "Canary request failed."
    };
  }
};

export const runLiveCanary = async ({
  manifestPath,
  baseUrl = resolveCanaryBaseUrl(),
  billingClientId = process.env.LINKDISH_CANARY_CLIENT_ID,
  billingProvider = process.env.LINKDISH_CANARY_BILLING_PROVIDER ?? "revenuecat",
  headers = {},
  timeoutMs = defaultTimeoutMs,
  fetchImplementation = fetch
}) => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const outputDir = path.resolve(".artifacts/live-canary");

  await fs.mkdir(outputDir, { recursive: true });

  const results = [];

  for (const entry of manifest) {
    const startedAt = Date.now();
    const extractHeaders = buildExtractHeaders({
      billingClientId: entry.billingClientId ?? billingClientId,
      billingProvider: entry.billingProvider ?? billingProvider,
      headers
    });
    const preflight = await preflightEntry({
      entry,
      timeoutMs,
      fetchImplementation
    });
    let primary = null;
    let fallback = null;

    if (!preflight.driftDetected) {
      primary = await invokeExtractAttempt({
        baseUrl,
        url: entry.url,
        attempt: "primary",
        headers: extractHeaders,
        timeoutMs,
        fetchImplementation
      });

      if (primary.payload?.status === "needs_retry") {
        fallback = await invokeExtractAttempt({
          baseUrl,
          url: entry.url,
          attempt: "fallback",
          headers: extractHeaders,
          timeoutMs,
          fetchImplementation
        });
      }
    }

    const primaryStatus = getAttemptStatus(primary);
    const fallbackStatus = getAttemptStatus(fallback);
    const finalStatus = fallbackStatus ?? primaryStatus;
    const outcome = validateExpectedOutcome({
      expectedMinimumOutcome: entry.expectedMinimumOutcome,
      finalStatus,
      driftDetected: preflight.driftDetected
    });

    results.push({
      ...entry,
      elapsedMs: Date.now() - startedAt,
      requestUrl: entry.url,
      finalUrl: preflight.finalUrl,
      statusCode: preflight.statusCode,
      timedOut: preflight.timedOut,
      driftDetected: preflight.driftDetected,
      driftReason: preflight.driftReason,
      preflight,
      primary,
      fallback,
      finalStatus,
      ...outcome
    });
  }

  const summary = results.reduce(
    (accumulator, result) => {
      accumulator.total += 1;

      if (result.driftDetected) {
        accumulator.manifestDrift += 1;
        accumulator.failed += 1;
        accumulator.driftReasons[result.driftReason] =
          (accumulator.driftReasons[result.driftReason] ?? 0) + 1;
        return accumulator;
      }

      accumulator.benchmarkTotal += 1;

      const primaryStatus = getAttemptStatus(result.primary);

      if (primaryStatus) {
        accumulator.primary[primaryStatus] = (accumulator.primary[primaryStatus] ?? 0) + 1;
      }

      const fallbackStatus = getAttemptStatus(result.fallback);

      if (fallbackStatus) {
        accumulator.fallback[fallbackStatus] = (accumulator.fallback[fallbackStatus] ?? 0) + 1;
      }

      const finalStatus = result.finalStatus;

      if (finalStatus) {
        accumulator.final[finalStatus] = (accumulator.final[finalStatus] ?? 0) + 1;
      }

      if (result.expectedOutcomeMet) {
        accumulator.passed += 1;
      } else {
        accumulator.failed += 1;
        accumulator.outcomeFailures += 1;
        accumulator.outcomeFailureReasons[result.outcomeFailureReason] =
          (accumulator.outcomeFailureReasons[result.outcomeFailureReason] ?? 0) + 1;
      }

      return accumulator;
    },
    {
      total: 0,
      manifestDrift: 0,
      benchmarkTotal: 0,
      passed: 0,
      failed: 0,
      outcomeFailures: 0,
      driftReasons: {},
      outcomeFailureReasons: {},
      primary: {},
      fallback: {},
      final: {}
    }
  );

  const payload = {
    ranAt: new Date().toISOString(),
    baseUrl,
    timeoutMs,
    summary,
    results
  };

  const outputPath = path.join(
    outputDir,
    `live-canary-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2));

  return {
    outputPath,
    summary
  };
};

export const main = async (argv = process.argv.slice(2)) => {
  const manifestPath = argv[0];

  if (!manifestPath) {
    console.error("Usage: node scripts/run-live-canary.mjs <manifest.json>");
    process.exit(1);
  }

  const result = await runLiveCanary({
    manifestPath
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.summary.failed > 0) {
    console.error(
      `Live canary failed: ${result.summary.failed} failing entries ` +
        `(${result.summary.manifestDrift} manifest drift, ` +
        `${result.summary.outcomeFailures} outcome failures).`
    );
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
