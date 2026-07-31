const defaultBaseUrl =
  process.env.LINKDISH_PRODUCTION_API_BASE_URL ?? "https://api.linkdish.ca";
const defaultTimeoutMs = 10_000;
const adminToken = process.env.LINKDISH_ADMIN_DASHBOARD_TOKEN ?? process.env.ADMIN_DASHBOARD_TOKEN;
const expectedLlmProvider = process.env.LINKDISH_EXPECTED_LLM_PROVIDER;
const expectedLlmModel = process.env.LINKDISH_EXPECTED_LLM_MODEL;

const withTimeout = async (work, timeoutMs) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseJsonSafely = async (response) => {
  const rawBody = await response.text();

  try {
    return {
      rawBody,
      parsedBody: JSON.parse(rawBody)
    };
  } catch {
    return {
      rawBody,
      parsedBody: null
    };
  }
};

const fetchJson = async ({ url, headers = {}, description }) => {
  let response;

  try {
    response = await withTimeout(
      (signal) =>
        fetch(url, {
          headers: {
            accept: "application/json",
            ...headers
          },
          signal
        }),
      defaultTimeoutMs
    );
  } catch (error) {
    throw new Error(`${description} request failed for ${url}`, {
      cause: error
    });
  }

  const { rawBody, parsedBody } = await parseJsonSafely(response);

  if (!response.ok) {
    throw new Error(
      `${description} failed with HTTP ${response.status}. Body: ${rawBody || "<empty>"}`
    );
  }

  if (!parsedBody) {
    throw new Error(`${description} returned non-JSON. Body: ${rawBody || "<empty>"}`);
  }

  return parsedBody;
};

const assertExpectedValue = (label, actual, expected) => {
  if (expected && actual !== expected) {
    throw new Error(`Expected ${label} to be ${expected}, but production reported ${actual}.`);
  }
};

const main = async () => {
  const normalizedBaseUrl = defaultBaseUrl.replace(/\/+$/, "");
  const healthUrl = `${normalizedBaseUrl}/health`;
  const dashboardUrl = `${normalizedBaseUrl}/admin/api/dashboard?environment=production`;
  const healthBody = await fetchJson({
    url: healthUrl,
    description: "Production API health check"
  });

  if (healthBody.ok !== true) {
    throw new Error(
      `Production API health check returned an unexpected payload. Body: ${JSON.stringify(healthBody)}`
    );
  }

  let llm = null;

  if (adminToken) {
    const dashboardBody = await fetchJson({
      url: dashboardUrl,
      headers: {
        "x-admin-dashboard-token": adminToken
      },
      description: "Production admin dashboard check"
    });

    llm = dashboardBody.llm ?? null;

    if (!llm || typeof llm !== "object") {
      throw new Error("Production admin dashboard did not include an llm snapshot.");
    }

    assertExpectedValue("LLM provider", llm.selectedProvider, expectedLlmProvider);
    assertExpectedValue("LLM model", llm.activeModel, expectedLlmModel);
  } else if (expectedLlmProvider || expectedLlmModel) {
    throw new Error(
      "Production LLM expectations were provided, but ADMIN_DASHBOARD_TOKEN or LINKDISH_ADMIN_DASHBOARD_TOKEN is missing."
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: defaultBaseUrl,
        healthUrl,
        dashboardUrl: adminToken ? dashboardUrl : null,
        llm: llm
          ? {
              selectedProvider: llm.selectedProvider,
              runtimeProvider: llm.runtimeProvider,
              activeModel: llm.activeModel,
              configSource: llm.configSource,
              updatedBy: llm.updatedBy,
              pricingKnown: Boolean(
                llm.catalog?.some(
                  (model) =>
                    model.provider === llm.selectedProvider &&
                    model.model === llm.activeModel &&
                    model.price?.source === "provider_docs"
                )
              )
            }
          : {
              skipped: true,
              reason:
                "Set ADMIN_DASHBOARD_TOKEN or LINKDISH_ADMIN_DASHBOARD_TOKEN to verify the effective production LLM model."
            }
      },
      null,
      2
    )
  );
};

try {
  await main();
} catch (error) {
  const message = (() => {
    if (!(error instanceof Error)) {
      return "Production API health check failed.";
    }

    if (error.name === "AbortError") {
      return `Production API health check timed out after ${defaultTimeoutMs}ms.`;
    }

    const cause =
      typeof error.cause === "object" && error.cause && "message" in error.cause
        ? String(error.cause.message)
        : null;

    if (cause) {
      return `${error.message} (${cause})`;
    }

    return error.message;
  })();

  console.error(message);
  process.exit(1);
}
