import { wait } from "@linkdish/utils";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { createWebAnalyticsId } from "../../analytics/session";
import { apiClient, ExtractorApiError, type ExtractRecipeResponse } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { EXTRACTION_ERROR_LINES, pickFlavorLine } from "../../lib/flavor-copy";
import { isOnline, addNetworkListeners } from "../../platform/detect-network";
import { formatMonthlyQuotaCopy, hasMonthlyQuotaFields } from "../billing/quota-copy";
import {
  canStartWebImport,
  canStartWebStrongExtraction,
  getWebBillingTier,
  spendWebImport,
  spendWebStrongExtraction
} from "../billing/web-billing";
import { InstallPrompt } from "../install/InstallPrompt";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import { ExtractForm } from "./ExtractForm";
import { ExtractionLoadingCopy } from "./ExtractionLoadingCopy";
import { ExtractResult } from "./ExtractResult";
import "./ExtractPage.css";

import type {
  ExtractRecipeImage,
  ExtractRecipeRequest,
  QuotaStatus
} from "@linkdish/api-contracts";
import type { V2AnalyticsImportAttempt, V2AnalyticsImportProperties } from "@linkdish/utils";

type ExtractionState =
  | "idle"
  | "submitting_primary"
  | "needs_retry"
  | "submitting_fallback"
  | "success"
  | "failure";

type ImportEntrySource = "in_app" | "share_sheet";
type ImportAnalyticsProperties = V2AnalyticsImportProperties & {
  source: ImportEntrySource;
};
type ActiveImport = {
  correlationId: string;
  properties: ImportAnalyticsProperties;
  terminal: boolean;
};

const getSourceHost = (value: string): string | undefined => {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return undefined;
  }
};

const getUrlImportProperties = (
  targetUrl: string,
  attempt: V2AnalyticsImportAttempt,
  source: ImportEntrySource
): ImportAnalyticsProperties => {
  const sourceHost = getSourceHost(targetUrl);

  return {
    attempt,
    source,
    source_type: source === "share_sheet" ? "share_target" : "url",
    ...(sourceHost ? { source_host: sourceHost } : {})
  };
};

const extractSharedUrl = (params: URLSearchParams): string | null => {
  const urlParam = params.get("url")?.trim();
  if (urlParam) {
    return urlParam;
  }

  const textParam = params.get("text")?.trim();
  const match = textParam?.match(/https?:\/\/[^\s<>"']+/iu);
  return match?.[0] ?? null;
};

const getQuotaFromUnknown = (value: unknown): QuotaStatus | undefined => {
  if (!value || typeof value !== "object" || !("quota" in value)) {
    return undefined;
  }

  return (value as { quota?: QuotaStatus }).quota;
};

export const ExtractPage: React.FC = () => {
  const { isAuthenticated, loading: authLoading, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<ExtractionState>("idle");
  const [url, setUrl] = useState("");
  const [importSource, setImportSource] = useState<ImportEntrySource>("in_app");
  const [sourceImages, setSourceImages] = useState<ExtractRecipeImage[] | undefined>();
  const [response, setResponse] = useState<ExtractRecipeResponse | null>(null);
  const [errorTitle, setErrorTitle] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [offline, setOffline] = useState(!isOnline());
  const [extractionErrorTitle] = useState(() => pickFlavorLine(EXTRACTION_ERROR_LINES));
  const autoStartedShareTargetRef = useRef<string | null>(null);
  const activeImportRef = useRef<ActiveImport | null>(null);
  const sharedTargetUrl = useMemo(() => extractSharedUrl(searchParams), [searchParams]);

  const abandonActiveImport = (reason: string) => {
    const activeImport = activeImportRef.current;

    if (!activeImport || activeImport.terminal) {
      return;
    }

    activeImport.terminal = true;
    trackWebV2AnalyticsEvent({
      name: "import_abandoned",
      correlationId: activeImport.correlationId,
      routeOrScreen: "/",
      properties: {
        ...activeImport.properties,
        abandonment_reason: reason
      }
    });
  };

  const beginImport = (properties: ImportAnalyticsProperties): ActiveImport => {
    abandonActiveImport("superseded");
    const activeImport = {
      correlationId: createWebAnalyticsId(),
      properties,
      terminal: false
    };
    activeImportRef.current = activeImport;
    return activeImport;
  };

  useEffect(() => {
    return addNetworkListeners({
      onOffline: () => setOffline(true),
      onOnline: () => setOffline(false)
    });
  }, []);

  // Calls backend with transient error retry (once after 750ms for 408/429/5xx)
  const extractWithRetry = async (
    request: ExtractRecipeRequest,
    attempt: "primary" | "fallback",
    isRetry = false
  ): Promise<ExtractRecipeResponse> => {
    try {
      const nextRequest =
        "images" in request
          ? { ...request, attempt: "fallback" as const }
          : { ...request, attempt };
      return await apiClient.extractRecipe(nextRequest);
    } catch (err) {
      if (!isRetry && err instanceof ExtractorApiError) {
        const status = err.statusCode;
        if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
          // Wait 750ms and retry once
          await wait(750);
          return await extractWithRetry(request, attempt, true);
        }
      }
      throw err;
    }
  };

  const handleUrlSubmit = async (targetUrl: string, source: ImportEntrySource = "in_app") => {
    if (authLoading) {
      return;
    }

    const tier = getWebBillingTier(user);

    if (!isOnline()) {
      setState("failure");
      setErrorTitle("You are offline");
      setErrorMessage(
        "Connect to the internet to extract a new recipe. Your saved recipes are still available in the Library."
      );
      setQuotaExceeded(false);
      return;
    }

    if (!isAuthenticated) {
      const importGate = canStartWebImport(tier);

      if (!importGate.allowed) {
        setState("failure");
        setErrorTitle(importGate.title ?? "Recipe imports used");
        setErrorMessage(
          importGate.message ?? "Your LinkDish recipe import limit has been reached."
        );
        setQuotaExceeded(true);
        requestUpgradeSheet("import_limit");
        return;
      }
    }

    setUrl(targetUrl);
    setImportSource(source);
    setSourceImages(undefined);
    setState("submitting_primary");
    setQuotaExceeded(false);
    setErrorMessage("");
    const importProperties = getUrlImportProperties(targetUrl, "primary", source);
    const activeImport = beginImport(importProperties);
    trackWebEvent({
      correlationId: activeImport.correlationId,
      eventName: "import_started",
      routeOrScreen: "/",
      properties: importProperties
    });

    try {
      const res = await extractWithRetry(
        {
          url: targetUrl,
          attempt: "primary",
          correlationId: activeImport.correlationId
        },
        "primary"
      );
      handleResponse(res, "primary", importProperties, activeImport.correlationId);
    } catch (err) {
      handleError(err, importProperties, activeImport.correlationId);
    }
  };

  const handleImagesSubmit = async (images: ExtractRecipeImage[]) => {
    if (authLoading) {
      return;
    }

    const tier = getWebBillingTier(user);

    if (!isOnline()) {
      setState("failure");
      setErrorTitle("You are offline");
      setErrorMessage("Connect to the internet to scan a new recipe.");
      setQuotaExceeded(false);
      return;
    }

    if (!isAuthenticated) {
      const importGate = canStartWebImport(tier);
      const strongGate = canStartWebStrongExtraction(tier);

      if (!importGate.allowed || !strongGate.allowed) {
        const gate = !importGate.allowed ? importGate : strongGate;
        setState("failure");
        setErrorTitle(gate.title ?? "Recipe imports used");
        setErrorMessage(gate.message ?? "Your LinkDish recipe import limit has been reached.");
        setQuotaExceeded(true);
        requestUpgradeSheet("import_limit");
        return;
      }
    }

    const sourceUrl = `https://linkdish.app/image-imports/web-${Date.now()}-${crypto.randomUUID()}`;
    setUrl(sourceUrl);
    setImportSource("in_app");
    setSourceImages(images);
    setState("submitting_fallback");
    setQuotaExceeded(false);
    setErrorMessage("");
    const importProperties: ImportAnalyticsProperties = {
      attempt: "fallback",
      source: "in_app",
      source_type: "image"
    };
    const activeImport = beginImport(importProperties);
    trackWebEvent({
      correlationId: activeImport.correlationId,
      eventName: "import_started",
      routeOrScreen: "/",
      properties: importProperties
    });

    try {
      const res = await extractWithRetry(
        {
          attempt: "fallback",
          images,
          sourceUrl,
          correlationId: activeImport.correlationId
        },
        "fallback"
      );
      handleResponse(res, "fallback", importProperties, activeImport.correlationId);
    } catch (err) {
      handleError(err, importProperties, activeImport.correlationId);
    }
  };

  const handleFallbackSubmit = async () => {
    if (authLoading) {
      return;
    }

    const tier = getWebBillingTier(user);

    if (!isOnline()) {
      setState("failure");
      setErrorTitle("You are offline");
      setErrorMessage("Connect to the internet to retry extraction.");
      setQuotaExceeded(false);
      return;
    }

    if (!isAuthenticated) {
      const strongGate = canStartWebStrongExtraction(tier);

      if (!strongGate.allowed) {
        setState("failure");
        setErrorTitle(strongGate.title ?? "Recipe imports used");
        setErrorMessage(
          strongGate.message ?? "Your LinkDish recipe import limit has been reached."
        );
        setQuotaExceeded(true);
        requestUpgradeSheet("import_limit");
        return;
      }
    }

    setState("submitting_fallback");
    setErrorMessage("");
    const importProperties = getUrlImportProperties(url, "fallback", importSource);
    const existingImport = activeImportRef.current;
    const activeImport =
      existingImport && !existingImport.terminal ? existingImport : beginImport(importProperties);
    activeImport.properties = importProperties;

    try {
      const res = await extractWithRetry(
        { url, attempt: "fallback", correlationId: activeImport.correlationId },
        "fallback"
      );
      handleResponse(res, "fallback", importProperties, activeImport.correlationId);
    } catch (err) {
      handleError(err, importProperties, activeImport.correlationId);
    }
  };

  const handleResponse = (
    res: ExtractRecipeResponse,
    attempt: "primary" | "fallback",
    importProperties: ImportAnalyticsProperties,
    correlationId: string
  ) => {
    if (
      activeImportRef.current?.correlationId !== correlationId ||
      activeImportRef.current.terminal
    ) {
      return;
    }

    setResponse(res);
    if (res.status === "success") {
      trackWebV2AnalyticsEvent({
        name: "import_succeeded",
        correlationId,
        routeOrScreen: "/",
        properties: {
          ...importProperties,
          attempt,
          fetch_mode: res.extraction.fetchMode,
          provenance_count: res.extraction.provenance.length,
          strategy: res.extraction.strategy,
          warning_count: res.extraction.warnings.length
        }
      });

      if (!isAuthenticated) {
        spendWebImport(getWebBillingTier(user));

        if (attempt === "fallback") {
          spendWebStrongExtraction(getWebBillingTier(user));
        }
      }

      const quota = getQuotaFromUnknown(res);
      if (hasMonthlyQuotaFields(quota) && quota.remainingThisMonth === 1) {
        requestUpgradeSheet("fourth_import_month");
      }

      setState("success");
    } else if (res.status === "needs_retry") {
      trackWebV2AnalyticsEvent({
        name: "import_needs_retry",
        correlationId,
        routeOrScreen: "/",
        properties: {
          ...importProperties,
          attempt,
          retry_reason: res.reason
        }
      });
      setState("needs_retry");
    } else if (res.status === "failure") {
      if (activeImportRef.current?.correlationId === correlationId) {
        activeImportRef.current.terminal = true;
      }
      trackWebV2AnalyticsEvent({
        name: "import_failed",
        correlationId,
        routeOrScreen: "/",
        properties: {
          ...importProperties,
          attempt,
          failure_reason: res.reason
        }
      });
      setState("failure");
      setErrorTitle(extractionErrorTitle);
      setErrorMessage(formatMonthlyQuotaCopy(res.quota, res.userMessage));
      if (res.reason === "quota_exceeded" || res.reason === "plan_limit") {
        setQuotaExceeded(true);
        requestUpgradeSheet("import_limit");
      }
    }

    if (res.status === "success" && activeImportRef.current?.correlationId === correlationId) {
      activeImportRef.current.terminal = true;
    }
  };

  const handleError = (
    err: unknown,
    importProperties: ImportAnalyticsProperties,
    correlationId: string
  ) => {
    if (
      activeImportRef.current?.correlationId !== correlationId ||
      activeImportRef.current.terminal
    ) {
      return;
    }

    activeImportRef.current.terminal = true;
    trackWebV2AnalyticsEvent({
      name: "import_failed",
      correlationId,
      routeOrScreen: "/",
      properties: {
        ...importProperties,
        failure_reason: err instanceof ExtractorApiError ? "api_error" : "network_error",
        ...(err instanceof ExtractorApiError ? { status_code: err.statusCode } : {})
      }
    });
    setState("failure");
    setErrorTitle(extractionErrorTitle);

    if (err instanceof ExtractorApiError) {
      const quota = getQuotaFromUnknown(err.details);
      setErrorMessage(
        formatMonthlyQuotaCopy(quota, err.message || "The extraction server returned an error.")
      );
      if (err.statusCode === 403 || err.statusCode === 429) {
        setQuotaExceeded(true);
        requestUpgradeSheet("import_limit");
      }
    } else {
      setErrorMessage(
        "Could not connect to the LinkDish API. Please check your internet connection."
      );
    }
  };

  const handleReset = () => {
    const activeImport = activeImportRef.current;

    if (activeImport && !activeImport.terminal) {
      activeImport.terminal = true;
      trackWebV2AnalyticsEvent({
        name: "import_cancelled",
        correlationId: activeImport.correlationId,
        routeOrScreen: "/",
        properties: {
          ...activeImport.properties,
          cancellation_reason: "user_reset"
        }
      });
    }

    setState("idle");
    setResponse(null);
    setUrl("");
    setSourceImages(undefined);
    setErrorMessage("");
    setImportSource("in_app");
    setQuotaExceeded(false);
  };

  useEffect(
    () => () => {
      abandonActiveImport("page_unmounted");
    },
    []
  );

  useEffect(() => {
    if (
      !sharedTargetUrl ||
      authLoading ||
      state !== "idle" ||
      autoStartedShareTargetRef.current === sharedTargetUrl
    ) {
      return;
    }

    autoStartedShareTargetRef.current = sharedTargetUrl;
    void handleUrlSubmit(sharedTargetUrl, "share_sheet");
  }, [authLoading, sharedTargetUrl, state]);

  return (
    <div className="extract-page container page-enter">
      {offline && state === "idle" && (
        <div className="offline-banner" role="status" aria-live="polite">
          <span className="offline-icon">📡</span> You are offline. Saved recipes are still
          available in your <Link to="/">Cookbook</Link>.
        </div>
      )}

      {state === "idle" && (
        <>
          <div className="hero-section">
            <p className="hero-eyebrow">LINKDISH</p>
            <h1 className="hero-title">
              <span className="hero-title-line">Paste a link.</span>
              <span className="hero-title-line hero-title-line-accent">Get cooking.</span>
            </h1>
          </div>
          <ExtractForm
            onSubmit={handleUrlSubmit}
            onImagesSubmit={handleImagesSubmit}
            loading={authLoading}
          />
          <InstallPrompt />
        </>
      )}

      {(state === "submitting_primary" || state === "submitting_fallback") && (
        <LoadingState message={<ExtractionLoadingCopy />} />
      )}

      {state === "needs_retry" && response?.status === "needs_retry" && (
        <Card className="needs-retry-card" variant="default">
          <h2 className="retry-title">Deeper Extraction Recommended</h2>
          <p className="retry-message">{response.userMessage}</p>

          <div className="retry-diagnostics">
            <p className="diagnostic-text">
              Confidence Score:{" "}
              <strong>{Math.round(response.diagnostics.confidenceScore * 100)}%</strong>
            </p>
            {response.diagnostics.missingFields.length > 0 && (
              <p className="diagnostic-text">
                Missing details: <strong>{response.diagnostics.missingFields.join(", ")}</strong>
              </p>
            )}
          </div>

          <div className="retry-actions">
            <Button variant="primary" onClick={handleFallbackSubmit} loading={authLoading}>
              Try Deeper Extraction
            </Button>
            <Button variant="ghost" onClick={handleReset}>
              Cancel & Start Over
            </Button>
          </div>
        </Card>
      )}

      {state === "success" && response?.status === "success" && (
        <ExtractResult
          recipe={response.recipe}
          sourceUrl={url}
          sourceImages={sourceImages}
          extraction={{
            fetchMode: response.extraction.fetchMode,
            provenance: response.extraction.provenance,
            strategy: response.extraction.strategy,
            warnings: response.extraction.warnings
          }}
          onReset={handleReset}
        />
      )}

      {state === "failure" && (
        <div className="failure-container animate-fade-in">
          <ErrorState
            title={errorTitle}
            message={errorMessage}
            onRetry={quotaExceeded ? undefined : handleReset}
            retryLabel="Try another URL"
          />
          {quotaExceeded && (
            <Card variant="subtle" className="quota-upgrade-card">
              <h3>Need more imports?</h3>
              <p>You have reached the import limit for your plan. Upgrade for higher quotas.</p>
              <div className="upgrade-actions">
                <ButtonLink to="/pricing" variant="primary">
                  View Pricing Plans
                </ButtonLink>
                <Button variant="ghost" onClick={handleReset}>
                  Back
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};
