import { ExtractorApiError } from "@linkdish/api-client";
import { useEffect, useMemo, useRef, useState } from "react";

import { createMobileAnalyticsId, trackMobileEvent } from "../../../analytics/client";
import { isTextExtractionRequest } from "../../../services/extraction-request";
import { extractRecipe } from "../../../services/extractor-api";
import { useAccount } from "../../account/AccountContext";
import { useBilling } from "../../billing/BillingContext";
import { formatMonthlyQuotaCopy } from "../../billing/quota-copy";
import { useOptionalUpgradeMoment } from "../../billing/UpgradeMomentContext";
import { INVALID_RECIPE_URL_MESSAGE, isAllowedRecipeUrl } from "../../recipe-intake/urlValidation";
import { restoreSavedRecipeState, type SavedRecipeRecord } from "../../saved-recipes/store";
import { getDraftRecipeExtraction, saveDraftRecipeExtraction } from "../draftStore";

import type { MobileExtractionRequest } from "../../../services/extraction-request";
import type { ExtractionUiState, RecipeSourceImage, SuccessfulExtractionState } from "../types";

interface UseRecipeExtractionResult {
  state: ExtractionUiState;
  retryPrimary: () => Promise<void>;
  retryWithFallback: () => Promise<void>;
  createInspiredRecipe: () => Promise<void>;
}

export const EXTRACTION_TIMEOUT_MS = 150_000;
type RecipeExtractionSource = MobileExtractionRequest | string | undefined;
type RecipeExtractionEntrySource = "in_app" | "share_sheet";
type InFlightExtraction = {
  key: string;
  promise: Promise<void>;
  requestVersion: number;
};
type ImportLifecycle = {
  correlationId: string;
  requestVersion: number;
  started: boolean;
  terminal: boolean;
};

interface UseRecipeExtractionOptions {
  importSource?: RecipeExtractionEntrySource;
  routeOrScreen?: string;
}

const getExtractionRequest = (
  source: RecipeExtractionSource
): MobileExtractionRequest | undefined =>
  typeof source === "string" ? { url: source, attempt: "primary" } : source;

const getRequestSourceUrl = (request: MobileExtractionRequest | undefined): string | undefined => {
  if (!request) {
    return undefined;
  }

  return isTextExtractionRequest(request)
    ? request.routeUrl
    : "images" in request
      ? request.sourceUrl
      : request.url;
};

const getInitialAttempt = (
  request: MobileExtractionRequest | undefined
): "primary" | "fallback" => {
  if (!request) {
    return "primary";
  }

  return "images" in request ? "fallback" : request.attempt;
};

const buildRequestForAttempt = (
  request: MobileExtractionRequest,
  attempt: "primary" | "fallback",
  correlationId?: string
): MobileExtractionRequest =>
  "images" in request
    ? { ...request, attempt: "fallback", ...(correlationId ? { correlationId } : {}) }
    : { ...request, attempt, ...(correlationId ? { correlationId } : {}) };

/** The scans an image import sent, as in-memory `data:` images the screen can show and save. */
const getRequestSourceImages = (
  request: MobileExtractionRequest
): RecipeSourceImage[] | undefined =>
  "images" in request
    ? request.images.map((image) => ({ mimeType: image.mimeType, uri: image.dataUrl }))
    : undefined;

const getSavedRecipeRestoreKey = (savedRecipe: SavedRecipeRecord): string =>
  [savedRecipe.id, savedRecipe.updatedAt ?? savedRecipe.savedAt, savedRecipe.recipe.sourceUrl].join(
    ":"
  );

const getExtractionRequestKey = (request: MobileExtractionRequest): string =>
  isTextExtractionRequest(request)
    ? ["text", request.routeUrl, request.attempt, request.text.length].join(":")
    : "images" in request
      ? [
          "images",
          request.sourceUrl,
          request.attempt,
          request.images.length,
          request.images.map((image) => `${image.mimeType}:${image.dataUrl.length}`).join(",")
        ].join(":")
      : ["url", request.url, request.attempt].join(":");

const getTransportFailureMessage = (error: unknown) => {
  const fallbackMessage =
    "LinkDish could not reach the extraction service. Please try again in a moment.";

  if (!(error instanceof Error)) {
    return fallbackMessage;
  }

  // api-client v2 reports transport failures as ExtractorApiError with a kind.
  if (error instanceof ExtractorApiError && error.kind === "timeout") {
    return "The extraction service took too long to answer. Please try again in a moment.";
  }

  if (error instanceof ExtractorApiError && error.kind === "network") {
    return fallbackMessage;
  }

  if (error.message.trim().length === 0 || error.message === "Network request failed") {
    return fallbackMessage;
  }

  return `LinkDish could not reach the extraction service. ${error.message}`;
};

const getSourceHost = (sourceUrl: string): string | undefined => {
  try {
    return new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return undefined;
  }
};

const getImportEventProperties = (
  request: MobileExtractionRequest,
  requestSourceUrl: string,
  importSource: RecipeExtractionEntrySource
) => {
  const sourceHost =
    "images" in request || isTextExtractionRequest(request)
      ? undefined
      : getSourceHost(requestSourceUrl);

  return {
    attempt: request.attempt,
    source: importSource,
    source_type: isTextExtractionRequest(request)
      ? "text"
      : "images" in request
        ? "image"
        : importSource === "share_sheet"
          ? "share_target"
          : "url",
    ...(sourceHost ? { source_host: sourceHost } : {})
  };
};

const trackImportStarted = (
  request: MobileExtractionRequest,
  requestSourceUrl: string,
  importSource: RecipeExtractionEntrySource,
  routeOrScreen: string,
  correlationId: string
) => {
  trackMobileEvent({
    correlationId,
    eventName: "import_started",
    routeOrScreen,
    properties: getImportEventProperties(request, requestSourceUrl, importSource)
  });
};

/**
 * The "one free import left" upgrade moment (analytics trigger `fourth_import_monthly`, named
 * when Free had 5 imports) fires on the successful import that leaves exactly one of the
 * locally metered Free allowance. It used to require `monthlyImports === 5`, which never
 * matched the current 3-import Free plan, so the moment could not fire.
 */
export const shouldShowLastFreeImportPrompt = (input: {
  planId: string;
  remainingImportsBeforeThisImport: number;
  usesServerBillingGate: boolean;
}): boolean =>
  !input.usesServerBillingGate &&
  input.planId === "free" &&
  input.remainingImportsBeforeThisImport === 2;

export const useRecipeExtraction = (
  source: RecipeExtractionSource,
  savedRecipe?: SavedRecipeRecord,
  options: UseRecipeExtractionOptions = {}
): UseRecipeExtractionResult => {
  const {
    canStartImport,
    canStartStrongExtraction,
    hasLoadedBilling,
    plan,
    revenueCatAppUserId,
    remainingImports,
    spendImport,
    spendStrongExtraction
  } = useBilling();
  const { showUpgradeMoment } = useOptionalUpgradeMoment();
  const { getAuthToken, isSignedIn } = useAccount();
  const extractionRequest = useMemo(() => getExtractionRequest(source), [source]);
  const requestSourceUrl = getRequestSourceUrl(extractionRequest);
  const initialAttempt = getInitialAttempt(extractionRequest);
  const importSource = options.importSource ?? "in_app";
  const routeOrScreen = options.routeOrScreen ?? "recipe";
  const displayedRecipeUrlRef = useRef<string | undefined>(
    savedRecipe ? (requestSourceUrl ?? savedRecipe.recipe.sourceUrl) : undefined
  );
  const requestVersionRef = useRef(0);
  const inFlightExtractionRef = useRef<InFlightExtraction | null>(null);
  const importLifecycleRef = useRef<ImportLifecycle | null>(null);
  const restoredSavedRecipeKeyRef = useRef<string | null>(
    savedRecipe ? getSavedRecipeRestoreKey(savedRecipe) : null
  );
  const [state, setState] = useState<ExtractionUiState>(() =>
    savedRecipe
      ? restoreSavedRecipeState(savedRecipe)
      : extractionRequest && requestSourceUrl && !isAllowedRecipeUrl(requestSourceUrl)
        ? {
            state: "failure",
            reason: "unsupported_source",
            message: INVALID_RECIPE_URL_MESSAGE,
            allowFallback: false,
            suggestedAction: "try_another_url"
          }
        : extractionRequest
          ? { state: "loading", attempt: initialAttempt }
          : { state: "empty" }
  );

  useEffect(() => {
    if (state.state !== "loading" || !requestSourceUrl) {
      return;
    }

    const timer = setTimeout(() => {
      requestVersionRef.current += 1;
      inFlightExtractionRef.current = null;
      const lifecycle = importLifecycleRef.current;
      if (lifecycle) {
        lifecycle.terminal = true;
      }
      setState({
        state: "failure",
        reason: "transport_error",
        message: "This is taking longer than expected. Please try again.",
        allowFallback: false,
        suggestedAction: "retry_primary"
      });
    }, EXTRACTION_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [requestSourceUrl, state.state, state.state === "loading" ? state.attempt : undefined]);

  const trackAbandonedImport = (
    lifecycle: ImportLifecycle | null,
    reason: string,
    request?: MobileExtractionRequest
  ) => {
    if (!lifecycle?.started || lifecycle.terminal || !request || !requestSourceUrl) {
      return;
    }

    lifecycle.terminal = true;
    trackMobileEvent({
      correlationId: lifecycle.correlationId,
      eventName: "import_abandoned",
      routeOrScreen,
      properties: {
        ...getImportEventProperties(request, requestSourceUrl, importSource),
        abandonment_reason: reason
      }
    });
  };

  const runExtraction = (
    attempt: "primary" | "fallback",
    options: { requestVersion?: number; correlationId?: string; inspired?: boolean } = {}
  ): Promise<void> => {
    const requestVersion = options.requestVersion ?? requestVersionRef.current + 1;

    if (!options.requestVersion) {
      requestVersionRef.current = requestVersion;
    }

    const isCurrentRequest = () => requestVersionRef.current === requestVersion;

    if (!extractionRequest || !requestSourceUrl) {
      if (isCurrentRequest()) {
        setState({ state: "empty" });
      }
      return Promise.resolve();
    }

    if (!isAllowedRecipeUrl(requestSourceUrl)) {
      if (isCurrentRequest()) {
        setState({
          state: "failure",
          reason: "unsupported_source",
          message: INVALID_RECIPE_URL_MESSAGE,
          allowFallback: false,
          suggestedAction: "try_another_url"
        });
      }
      return Promise.resolve();
    }

    const useServerBillingGate = isSignedIn;

    if (!useServerBillingGate && !hasLoadedBilling) {
      if (isCurrentRequest()) {
        setState({ state: "loading", attempt });
      }
      return Promise.resolve();
    }

    const localImportGate = useServerBillingGate ? null : canStartImport();

    if (localImportGate && !localImportGate.allowed) {
      if (isCurrentRequest()) {
        setState({
          state: "failure",
          reason: "plan_limit",
          message: localImportGate.message ?? "This month's LinkDish usage limit has been reached.",
          allowFallback: false,
          suggestedAction: "try_another_url"
        });
      }
      return Promise.resolve();
    }

    const currentLifecycle = importLifecycleRef.current;
    const shouldReuseLifecycle =
      currentLifecycle != null &&
      !currentLifecycle.terminal &&
      (currentLifecycle.requestVersion === requestVersion ||
        currentLifecycle.correlationId === options.correlationId);

    if (!shouldReuseLifecycle) {
      trackAbandonedImport(
        currentLifecycle,
        "superseded",
        buildRequestForAttempt(extractionRequest, attempt, currentLifecycle?.correlationId)
      );
      importLifecycleRef.current = {
        correlationId:
          options.correlationId ?? extractionRequest.correlationId ?? createMobileAnalyticsId(),
        requestVersion,
        started: false,
        terminal: false
      };
    } else {
      currentLifecycle.requestVersion = requestVersion;
    }

    const lifecycle = importLifecycleRef.current!;
    const baseRequest = buildRequestForAttempt(extractionRequest, attempt, lifecycle.correlationId);
    const request =
      options.inspired && "url" in baseRequest
        ? { ...baseRequest, inspired: true as const }
        : baseRequest;
    const requestAttempt = request.attempt;
    const inFlightKey = getExtractionRequestKey(request);

    const currentInFlightExtraction = inFlightExtractionRef.current;

    if (currentInFlightExtraction?.key === inFlightKey) {
      if (!options.requestVersion) {
        requestVersionRef.current = currentInFlightExtraction.requestVersion;
      }

      return currentInFlightExtraction.promise;
    }

    if (requestAttempt === "fallback" && !useServerBillingGate) {
      const fallbackGate = canStartStrongExtraction();

      if (!fallbackGate.allowed) {
        if (isCurrentRequest()) {
          setState({
            state: "failure",
            reason: "plan_limit",
            message: fallbackGate.message ?? "This month's LinkDish usage limit has been reached.",
            allowFallback: false,
            suggestedAction: "try_another_url"
          });
        }
        return Promise.resolve();
      }
    }

    const extractionPromise = (async () => {
      if (!isCurrentRequest()) {
        return;
      }

      setState({
        state: "loading",
        attempt: requestAttempt,
        ...(options.inspired ? { inspired: true } : {})
      });

      try {
        const authToken = await getAuthToken();

        if (!isCurrentRequest()) {
          return;
        }

        if (!lifecycle.started) {
          lifecycle.started = true;
          trackImportStarted(
            request,
            requestSourceUrl,
            importSource,
            routeOrScreen,
            lifecycle.correlationId
          );
        }
        const response = await extractRecipe(request, {
          authToken,
          billingClientId: revenueCatAppUserId
        });

        if (!isCurrentRequest()) {
          return;
        }

        if (response.status === "success") {
          const shouldShowFourthImportPrompt = shouldShowLastFreeImportPrompt({
            planId: plan.id,
            remainingImportsBeforeThisImport: remainingImports,
            usesServerBillingGate: useServerBillingGate
          });

          if (!useServerBillingGate) {
            spendImport();
          }

          if (requestAttempt === "fallback" && !useServerBillingGate) {
            spendStrongExtraction();
          }

          displayedRecipeUrlRef.current = requestSourceUrl;
          lifecycle.terminal = true;
          trackMobileEvent({
            correlationId: lifecycle.correlationId,
            eventName: "import_succeeded",
            routeOrScreen,
            properties: {
              ...getImportEventProperties(request, requestSourceUrl, importSource),
              fetch_mode: response.extraction.fetchMode,
              provenance_count: response.extraction.provenance.length,
              strategy: response.extraction.strategy,
              warning_count: response.extraction.warnings.length
            }
          });
          const successState: SuccessfulExtractionState = {
            state: "success",
            recipe: response.recipe,
            sourceImages: getRequestSourceImages(request),
            strategy: response.extraction.strategy,
            warnings: response.extraction.warnings,
            fetchMode: response.extraction.fetchMode,
            provenance: response.extraction.provenance
          };

          await saveDraftRecipeExtraction(requestSourceUrl, successState).catch((error) => {
            console.warn("Failed to save draft recipe extraction.", error);
          });
          setState(successState);

          if (shouldShowFourthImportPrompt) {
            showUpgradeMoment("fourth_import_monthly");
          }

          return;
        }

        if (
          response.status === "needs_retry" &&
          requestAttempt === "primary" &&
          (response.recovery?.allowFallback ?? true) &&
          (response.recovery?.suggestedAction ?? "retry_fallback") === "retry_fallback"
        ) {
          await runExtraction("fallback", {
            correlationId: lifecycle.correlationId,
            requestVersion
          });
          return;
        }

        if (response.status === "needs_retry") {
          trackMobileEvent({
            correlationId: lifecycle.correlationId,
            eventName: "import_needs_retry",
            routeOrScreen,
            properties: {
              ...getImportEventProperties(request, requestSourceUrl, importSource),
              retry_reason: response.reason
            }
          });
          setState({
            state: "retryable",
            reason: response.reason,
            message: response.userMessage,
            url: requestSourceUrl,
            allowFallback: response.recovery?.allowFallback ?? true,
            suggestedAction: response.recovery?.suggestedAction ?? "retry_fallback"
          });
          return;
        }

        lifecycle.terminal = true;
        trackMobileEvent({
          correlationId: lifecycle.correlationId,
          eventName: "import_failed",
          routeOrScreen,
          properties: {
            ...getImportEventProperties(request, requestSourceUrl, importSource),
            failure_reason: response.reason
          }
        });
        setState({
          state: "failure",
          reason: response.reason,
          message: formatMonthlyQuotaCopy(response.quota, response.userMessage),
          allowFallback: response.recovery?.allowFallback ?? false,
          quota: response.quota,
          inspiredAvailable: response.inspiredAvailable,
          suggestedAction: response.recovery?.suggestedAction ?? "try_another_url"
        });
      } catch (error) {
        if (!isCurrentRequest()) {
          return;
        }

        lifecycle.terminal = true;
        trackMobileEvent({
          correlationId: lifecycle.correlationId,
          eventName: "import_failed",
          routeOrScreen,
          properties: {
            ...getImportEventProperties(request, requestSourceUrl, importSource),
            failure_reason: "transport_error"
          }
        });

        if (process.env.NODE_ENV !== "production") {
          console.warn("Recipe extraction request failed.", {
            details: error instanceof ExtractorApiError ? error.details : undefined,
            message: error instanceof Error ? error.message : String(error),
            statusCode: error instanceof ExtractorApiError ? error.statusCode : undefined
          });
        }

        setState({
          state: "failure",
          reason: "transport_error",
          message: getTransportFailureMessage(error),
          allowFallback: false,
          suggestedAction: "retry_primary"
        });
      } finally {
        if (
          inFlightExtractionRef.current?.key === inFlightKey &&
          inFlightExtractionRef.current.requestVersion === requestVersion
        ) {
          inFlightExtractionRef.current = null;
        }
      }
    })();

    inFlightExtractionRef.current = {
      key: inFlightKey,
      promise: extractionPromise,
      requestVersion
    };
    return extractionPromise;
  };

  useEffect(() => {
    if (savedRecipe) {
      const savedRecipeRestoreKey = getSavedRecipeRestoreKey(savedRecipe);
      requestVersionRef.current += 1;
      displayedRecipeUrlRef.current = requestSourceUrl ?? savedRecipe.recipe.sourceUrl;

      if (restoredSavedRecipeKeyRef.current === savedRecipeRestoreKey) {
        return;
      }

      restoredSavedRecipeKeyRef.current = savedRecipeRestoreKey;
      setState(restoreSavedRecipeState(savedRecipe));
      return;
    }

    const wasShowingSavedRecipe = restoredSavedRecipeKeyRef.current !== null;
    restoredSavedRecipeKeyRef.current = null;

    if (!extractionRequest || !requestSourceUrl) {
      requestVersionRef.current += 1;
      displayedRecipeUrlRef.current = undefined;
      setState({ state: "empty" });
      return;
    }

    if (!isAllowedRecipeUrl(requestSourceUrl)) {
      requestVersionRef.current += 1;
      displayedRecipeUrlRef.current = undefined;
      setState({
        state: "failure",
        reason: "unsupported_source",
        message: INVALID_RECIPE_URL_MESSAGE,
        allowFallback: false,
        suggestedAction: "try_another_url"
      });
      return;
    }

    const initialRequestKey = getExtractionRequestKey(
      buildRequestForAttempt(extractionRequest, initialAttempt)
    );

    if (inFlightExtractionRef.current?.key === initialRequestKey) {
      return;
    }

    if (displayedRecipeUrlRef.current === requestSourceUrl) {
      if (wasShowingSavedRecipe) {
        // The saved copy of this recipe was removed and its scan files are deleted with it. Keep
        // the recipe on screen, but show (and let a later save persist) this import's own scans
        // instead of the saved record's files.
        const requestSourceImages = getRequestSourceImages(extractionRequest);
        setState((current) =>
          current.state === "success" ? { ...current, sourceImages: requestSourceImages } : current
        );
      }

      return;
    }

    let isActive = true;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    const restoreDraftOrExtract = async () => {
      try {
        const draftRecipe = await getDraftRecipeExtraction(requestSourceUrl);

        if (!isActive || requestVersionRef.current !== requestVersion) {
          return;
        }

        if (draftRecipe) {
          if (
            draftRecipe.recipe.confidence.notes.some((note) =>
              note.startsWith("AI-created recipe inspired by the video.")
            )
          ) {
            setState({
              state: "failure",
              reason: "parse_failed",
              message:
                "LinkDish could not find a complete recipe in the video or its available text.",
              inspiredAvailable: true,
              allowFallback: false,
              suggestedAction: "try_another_url"
            });
          } else {
            displayedRecipeUrlRef.current = requestSourceUrl;
            setState(restoreSavedRecipeState(draftRecipe));
          }
          return;
        }
      } catch (error) {
        console.warn("Failed to restore draft recipe extraction.", error);
      }

      if (!isActive || requestVersionRef.current !== requestVersion) {
        return;
      }

      await runExtraction(initialAttempt, { requestVersion });
    };

    void restoreDraftOrExtract();

    return () => {
      isActive = false;
      const lifecycle = importLifecycleRef.current;

      if (lifecycle?.requestVersion === requestVersion) {
        trackAbandonedImport(
          lifecycle,
          "screen_or_source_changed",
          buildRequestForAttempt(extractionRequest, initialAttempt, lifecycle.correlationId)
        );
      }
    };
  }, [
    extractionRequest,
    getAuthToken,
    hasLoadedBilling,
    importSource,
    initialAttempt,
    isSignedIn,
    plan.id,
    plan.limits.monthlyImports,
    requestSourceUrl,
    remainingImports,
    revenueCatAppUserId,
    routeOrScreen,
    savedRecipe,
    showUpgradeMoment
  ]);

  return {
    state,
    createInspiredRecipe: () => runExtraction("primary", { inspired: true }),
    retryPrimary: async () => {
      await runExtraction("primary", {
        ...(state.state === "retryable" && importLifecycleRef.current
          ? { correlationId: importLifecycleRef.current.correlationId }
          : {})
      });
    },
    retryWithFallback: async () => {
      await runExtraction("fallback", {
        ...(state.state === "retryable" && importLifecycleRef.current
          ? { correlationId: importLifecycleRef.current.correlationId }
          : {})
      });
    }
  };
};
