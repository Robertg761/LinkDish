import { useCallback, useEffect, useRef, useState } from "react";

import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { createWebAnalyticsId } from "../../analytics/session";
import { apiClient } from "../../api/client";
import { isExtractorApiError } from "../../api/errors";
import { useAuth } from "../../auth/AuthProvider";
import { enqueueImport, type ImportQueueItem } from "../../data/import-queue-store";
import { getSavedRecipesSnapshot, loadSavedRecipes } from "../../data/library-store";
import { isOnline } from "../../platform/detect-network";
import { hasMonthlyQuotaFields } from "../billing/quota-copy";
import {
  canStartWebImport,
  canStartWebStrongExtraction,
  getWebBillingTier,
  spendWebImport,
  spendWebStrongExtraction,
  webBillingPlans
} from "../billing/web-billing";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import { isSocialImportUrl } from "./import-input";
import {
  describeImportError,
  describeImportFailure,
  getImportErrorAnalytics
} from "./import-outcome";
import {
  findSavedDuplicate,
  getAnalyticsSourceHost,
  IMPORT_ANALYTICS_ROUTE
} from "./import-shared";

import type { ImportKind, ImportProblem } from "./import-outcome";
import type { WebBillingTier } from "../billing/web-billing";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type {
  ExtractRecipeImage,
  ExtractRecipeNeedsRetry,
  ExtractRecipeResponse,
  ExtractRecipeSuccess,
  QuotaStatus
} from "@linkdish/api-contracts";
import type { V2AnalyticsImportAttempt, V2AnalyticsImportProperties } from "@linkdish/utils";

/**
 * The import flow as one state machine: duplicate check (before any quota is spent), the
 * signed-out allowance, primary and AI-help attempts on one correlation id, a Cancel that really
 * aborts the request, offline queueing, and the import_* analytics lifecycle (exactly one
 * import_started per correlation id and exactly one terminal event).
 */

export type ImportEntrySource = "in_app" | "share_sheet";
export type ImportAttempt = V2AnalyticsImportAttempt;

export type ImportRequest =
  | { kind: "url"; url: string }
  | { kind: "text"; text: string; sourceUrl?: string | undefined }
  | { kind: "images"; images: ExtractRecipeImage[]; sourceUrl: string };

export type ImportPhase =
  | { status: "idle" }
  | {
      status: "duplicate";
      request: Extract<ImportRequest, { kind: "url" }>;
      existing: WebSavedRecipe;
    }
  | {
      status: "extracting";
      request: ImportRequest;
      attempt: ImportAttempt;
      startedAt: number;
      /** True when AI help started by itself (social captions, paid plans). */
      auto: boolean;
    }
  | {
      status: "needs_retry";
      request: Extract<ImportRequest, { kind: "url" }>;
      response: ExtractRecipeNeedsRetry;
    }
  | { status: "problem"; request: ImportRequest | null; problem: ImportProblem }
  | { status: "queued"; item: ImportQueueItem }
  | {
      status: "success";
      request: ImportRequest;
      response: ExtractRecipeSuccess;
      attempt: ImportAttempt;
      correlationId: string;
    };

type ImportAnalyticsProperties = V2AnalyticsImportProperties & { source: ImportEntrySource };

interface ActiveImport {
  correlationId: string;
  properties: ImportAnalyticsProperties;
  request: ImportRequest;
  controller: AbortController;
  terminal: boolean;
}

const TRANSIENT_RETRY_DELAY_MS = 750;

const isTransientError = (error: unknown): boolean => {
  if (!isExtractorApiError(error)) {
    return false;
  }

  const status = error.statusCode;
  return status === 408 || status === 429 || (status >= 500 && status < 600);
};

const abortableWait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const importKindOf = (request: ImportRequest): ImportKind => request.kind;

const analyticsPropertiesFor = (
  request: ImportRequest,
  attempt: ImportAttempt,
  source: ImportEntrySource
): ImportAnalyticsProperties => {
  if (request.kind === "images") {
    return { attempt: "fallback", source, source_type: "image" };
  }

  if (request.kind === "text") {
    return { attempt: "fallback", source, source_type: "text" };
  }

  const sourceHost = getAnalyticsSourceHost(request.url);
  return {
    attempt,
    source,
    source_type: source === "share_sheet" ? "share_target" : "url",
    ...(sourceHost ? { source_host: sourceHost } : {})
  };
};

/** Signed-out allowance problem (the on-device counter), phrased like the server's. */
const signedOutLimitProblem = (tier: WebBillingTier): ImportProblem => {
  const limit = webBillingPlans[tier].limits.monthlyImports;

  return {
    actions: ["see_plans"],
    detail: `0 of ${limit} free imports left`,
    icon: "sparkles",
    isPlanLimit: true,
    kind: "plan_limit",
    message: `Your first ${limit} imports were on us. Sign in and choose LinkDish Plus for 100 imports a month and room for every recipe you love.`,
    title: "You've used your free imports"
  };
};

export interface StartUrlOptions {
  source?: ImportEntrySource | undefined;
  /** "Import again" after the duplicate check. */
  skipDuplicateCheck?: boolean | undefined;
  /** Go straight to AI help (a retry of a page that needed it). */
  attempt?: ImportAttempt | undefined;
}

export interface ImportSession {
  phase: ImportPhase;
  /** The latest allowance the API reported (after a success or a limit). */
  quota: QuotaStatus | null;
  startUrl: (url: string, options?: StartUrlOptions) => Promise<void>;
  startText: (text: string, options?: { sourceUrl?: string | undefined }) => Promise<void>;
  startImages: (images: ExtractRecipeImage[], sourceUrl: string) => Promise<void>;
  /** "Try with AI help" on a needs_retry answer (same correlation id). */
  runFallback: () => Promise<void>;
  /** Runs the last request again as a new import. */
  retry: () => void;
  /** Aborts the request in flight (import_cancelled) and returns to the start. */
  cancel: () => void;
  /** Back to the start; an unfinished import is recorded as cancelled. */
  reset: () => void;
  /** Leaves the result on screen but forgets the import (after it was saved or discarded). */
  restore: (phase: ImportPhase) => void;
}

export function useImportSession(): ImportSession {
  const { credentialsReady, isAuthenticated, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const [phase, setPhase] = useState<ImportPhase>({ status: "idle" });
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const activeRef = useRef<ActiveImport | null>(null);
  const lastRequestRef = useRef<{ request: ImportRequest; source: ImportEntrySource } | null>(null);
  const mountedRef = useRef(true);
  const authRef = useRef({ credentialsReady, isAuthenticated, user });
  authRef.current = { credentialsReady, isAuthenticated, user };
  const authWaitersRef = useRef<Array<() => void>>([]);
  const upgradeRef = useRef(requestUpgradeSheet);
  upgradeRef.current = requestUpgradeSheet;
  /** Identifies the start in progress, so Cancel during the pre-checks stops it. */
  const pendingStartRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (!credentialsReady) {
      return;
    }

    const waiters = authWaitersRef.current;
    authWaitersRef.current = [];
    waiters.forEach((resolve) => resolve());
  }, [credentialsReady]);

  /**
   * Resolves once the request would carry the right account: auth has settled and a cached Clerk
   * user's session is usable (a share-sheet import at cold start must not run as anonymous).
   */
  const whenAuthReady = useCallback(
    (): Promise<void> =>
      !authRef.current.credentialsReady
        ? new Promise((resolve) => {
            authWaitersRef.current.push(resolve);
          })
        : Promise.resolve(),
    []
  );

  const safeSetPhase = useCallback((next: ImportPhase) => {
    if (mountedRef.current) {
      setPhase(next);
    }
  }, []);

  const endActive = useCallback(
    (
      name: "import_cancelled" | "import_abandoned",
      reason: string,
      options: { abort: boolean }
    ) => {
      const active = activeRef.current;

      if (!active || active.terminal) {
        return;
      }

      active.terminal = true;

      if (options.abort) {
        active.controller.abort();
      }

      if (name === "import_cancelled") {
        trackWebV2AnalyticsEvent({
          correlationId: active.correlationId,
          name,
          properties: { ...active.properties, cancellation_reason: reason },
          routeOrScreen: IMPORT_ANALYTICS_ROUTE
        });
      } else {
        trackWebV2AnalyticsEvent({
          correlationId: active.correlationId,
          name,
          properties: { ...active.properties, abandonment_reason: reason },
          routeOrScreen: IMPORT_ANALYTICS_ROUTE
        });
      }
    },
    []
  );

  const beginImport = useCallback(
    (request: ImportRequest, attempt: ImportAttempt, source: ImportEntrySource): ActiveImport => {
      endActive("import_abandoned", "superseded", { abort: true });
      const properties = analyticsPropertiesFor(request, attempt, source);
      const active: ActiveImport = {
        controller: new AbortController(),
        correlationId: createWebAnalyticsId(),
        properties,
        request,
        terminal: false
      };
      activeRef.current = active;
      lastRequestRef.current = { request, source };
      trackWebEvent({
        correlationId: active.correlationId,
        eventName: "import_started",
        properties,
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });
      return active;
    },
    [endActive]
  );

  const isCurrent = (active: ActiveImport) => activeRef.current === active && !active.terminal;

  const callExtract = (
    request: ImportRequest,
    attempt: ImportAttempt,
    active: ActiveImport
  ): Promise<ExtractRecipeResponse> => {
    const options = { signal: active.controller.signal };

    if (request.kind === "images") {
      return apiClient.extractRecipe(
        {
          attempt: "fallback",
          correlationId: active.correlationId,
          images: request.images,
          sourceUrl: request.sourceUrl
        },
        options
      );
    }

    if (request.kind === "text") {
      return apiClient.extractRecipeFromText(
        {
          attempt: "fallback",
          correlationId: active.correlationId,
          text: request.text,
          ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {})
        },
        options
      );
    }

    return apiClient.extractRecipe(
      { attempt, correlationId: active.correlationId, url: request.url },
      options
    );
  };

  /** One silent retry for transient server trouble; never for photo uploads. */
  const extractOnce = async (
    request: ImportRequest,
    attempt: ImportAttempt,
    active: ActiveImport
  ): Promise<ExtractRecipeResponse> => {
    try {
      return await callExtract(request, attempt, active);
    } catch (error) {
      if (
        request.kind === "images" ||
        !isTransientError(error) ||
        active.controller.signal.aborted
      ) {
        throw error;
      }

      await abortableWait(TRANSIENT_RETRY_DELAY_MS, active.controller.signal);
      return callExtract(request, attempt, active);
    }
  };

  const tierNow = (): WebBillingTier => getWebBillingTier(authRef.current.user);

  /** The signed-out allowance; signed-in imports are metered by the API. */
  const checkLocalAllowance = (needsStrong: boolean): ImportProblem | null => {
    if (authRef.current.isAuthenticated) {
      return null;
    }

    const tier = tierNow();
    const importGate = canStartWebImport(tier);
    const strongGate = needsStrong ? canStartWebStrongExtraction(tier) : { allowed: true };

    return importGate.allowed && strongGate.allowed ? null : signedOutLimitProblem(tier);
  };

  const showProblem = useCallback(
    (request: ImportRequest | null, problem: ImportProblem) => {
      safeSetPhase({ problem, request, status: "problem" });

      if (problem.isPlanLimit) {
        upgradeRef.current("import_limit");
      }
    },
    [safeSetPhase]
  );

  const canAutoRunFallback = (
    request: Extract<ImportRequest, { kind: "url" }>,
    response: ExtractRecipeNeedsRetry
  ): boolean => {
    const recovery = response.recovery;

    if (recovery && (!recovery.allowFallback || recovery.suggestedAction === "try_another_url")) {
      return false;
    }

    const social =
      response.sourceType === "social" ||
      response.sourceType === "video" ||
      isSocialImportUrl(request.url);
    const paid = tierNow() !== "free";

    return (social || paid) && checkLocalAllowance(true) === null;
  };

  const handleResponse = async (
    active: ActiveImport,
    response: ExtractRecipeResponse,
    attempt: ImportAttempt
  ): Promise<void> => {
    if (!isCurrent(active)) {
      return;
    }

    const { request } = active;
    const properties = { ...active.properties, attempt };

    if (response.status === "success") {
      active.terminal = true;
      trackWebV2AnalyticsEvent({
        correlationId: active.correlationId,
        name: "import_succeeded",
        properties: {
          ...properties,
          fetch_mode: response.extraction.fetchMode,
          provenance_count: response.extraction.provenance.length,
          strategy: response.extraction.strategy,
          warning_count: response.extraction.warnings.length
        },
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });

      if (!authRef.current.isAuthenticated) {
        const tier = tierNow();
        spendWebImport(tier);

        if (attempt === "fallback") {
          spendWebStrongExtraction(tier);
        }
      }

      if (response.quota) {
        setQuota(response.quota);

        if (hasMonthlyQuotaFields(response.quota) && response.quota.remainingThisMonth === 1) {
          upgradeRef.current("fourth_import_month");
        }
      }

      safeSetPhase({
        attempt,
        correlationId: active.correlationId,
        request,
        response,
        status: "success"
      });
      return;
    }

    if (response.status === "needs_retry") {
      trackWebV2AnalyticsEvent({
        correlationId: active.correlationId,
        name: "import_needs_retry",
        properties: { ...properties, retry_reason: response.reason },
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });

      if (request.kind === "url" && attempt === "primary") {
        if (canAutoRunFallback(request, response)) {
          await runAttempt(active, "fallback", { auto: true });
          return;
        }

        safeSetPhase({ request, response, status: "needs_retry" });
        return;
      }

      // Text, photos and AI help itself have nothing further to try: treat as not found.
      active.terminal = true;
      trackWebV2AnalyticsEvent({
        correlationId: active.correlationId,
        name: "import_failed",
        properties: { ...properties, failure_reason: response.reason },
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });
      showProblem(
        request,
        describeImportFailure(
          { reason: "parse_failed", status: "failure", userMessage: response.userMessage },
          { kind: importKindOf(request), plan: tierNow() }
        )
      );
      return;
    }

    active.terminal = true;
    trackWebV2AnalyticsEvent({
      correlationId: active.correlationId,
      name: "import_failed",
      properties: { ...properties, failure_reason: response.reason },
      routeOrScreen: IMPORT_ANALYTICS_ROUTE
    });

    if (response.quota) {
      setQuota(response.quota);
    }

    showProblem(
      request,
      describeImportFailure(response, { kind: importKindOf(request), plan: tierNow() })
    );
  };

  const handleError = (active: ActiveImport, error: unknown, attempt: ImportAttempt) => {
    if (!isCurrent(active) || active.controller.signal.aborted) {
      return;
    }

    active.terminal = true;
    trackWebV2AnalyticsEvent({
      correlationId: active.correlationId,
      name: "import_failed",
      properties: { ...active.properties, attempt, ...getImportErrorAnalytics(error) },
      routeOrScreen: IMPORT_ANALYTICS_ROUTE
    });
    showProblem(
      active.request,
      describeImportError(error, { kind: importKindOf(active.request), plan: tierNow() })
    );
  };

  async function runAttempt(
    active: ActiveImport,
    attempt: ImportAttempt,
    options: { auto?: boolean | undefined } = {}
  ): Promise<void> {
    active.properties = { ...active.properties, attempt };
    safeSetPhase({
      attempt,
      auto: Boolean(options.auto),
      request: active.request,
      startedAt: Date.now(),
      status: "extracting"
    });

    try {
      const response = await extractOnce(active.request, attempt, active);
      await handleResponse(active, response, attempt);
    } catch (error) {
      handleError(active, error, attempt);
    }
  }

  const queueOffline = async (request: ImportRequest, source: ImportEntrySource) => {
    if (request.kind === "images") {
      showProblem(
        request,
        describeImportError(new TypeError("offline"), { kind: "images", plan: tierNow() })
      );
      return;
    }

    try {
      const item = await enqueueImport(
        request.kind === "url"
          ? { source, url: request.url }
          : {
              source,
              text: request.text,
              ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {})
            }
      );
      trackWebEvent({
        eventName: "import_queued_offline",
        properties: { source, source_type: request.kind === "url" ? "url" : "text" },
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });
      safeSetPhase({ item, status: "queued" });
    } catch (error) {
      showProblem(
        request,
        describeImportError(error, { kind: importKindOf(request), plan: tierNow() })
      );
    }
  };

  const start = async (
    request: ImportRequest,
    options: {
      source: ImportEntrySource;
      attempt: ImportAttempt;
      skipDuplicateCheck?: boolean | undefined;
    }
  ): Promise<void> => {
    lastRequestRef.current = { request, source: options.source };

    if (!isOnline()) {
      await queueOffline(request, options.source);
      return;
    }

    // Show progress straight away; the checks below take a moment at most.
    safeSetPhase({
      attempt: options.attempt,
      auto: false,
      request,
      startedAt: Date.now(),
      status: "extracting"
    });
    const startToken = Symbol("start");
    pendingStartRef.current = startToken;
    await whenAuthReady();

    if (pendingStartRef.current !== startToken || !mountedRef.current) {
      return;
    }

    if (request.kind === "url" && !options.skipDuplicateCheck) {
      await loadSavedRecipes();

      if (pendingStartRef.current !== startToken || !mountedRef.current) {
        return;
      }

      const existing = findSavedDuplicate(request.url, getSavedRecipesSnapshot().data);

      if (existing) {
        endActive("import_abandoned", "superseded", { abort: true });
        safeSetPhase({ existing, request, status: "duplicate" });
        return;
      }
    }

    const needsStrong = request.kind !== "url" || options.attempt === "fallback";
    const limitProblem = checkLocalAllowance(needsStrong);

    if (limitProblem) {
      endActive("import_abandoned", "superseded", { abort: true });
      showProblem(request, limitProblem);
      return;
    }

    pendingStartRef.current = null;
    const active = beginImport(request, options.attempt, options.source);
    await runAttempt(active, options.attempt);
  };

  // The public actions are stable and always run the latest implementation.
  const implRef = useRef({ checkLocalAllowance, runAttempt, showProblem, start });
  implRef.current = { checkLocalAllowance, runAttempt, showProblem, start };

  const startUrl = useCallback(
    (url: string, options: StartUrlOptions = {}) =>
      implRef.current.start(
        { kind: "url", url },
        {
          attempt: options.attempt ?? "primary",
          skipDuplicateCheck: options.skipDuplicateCheck,
          source: options.source ?? "in_app"
        }
      ),
    []
  );

  const startText = useCallback(
    (text: string, options: { sourceUrl?: string | undefined } = {}) =>
      implRef.current.start(
        {
          kind: "text",
          text: text.trim(),
          ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {})
        },
        { attempt: "fallback", source: "in_app" }
      ),
    []
  );

  const startImages = useCallback(
    (images: ExtractRecipeImage[], sourceUrl: string) =>
      implRef.current.start(
        { images, kind: "images", sourceUrl },
        { attempt: "fallback", source: "in_app" }
      ),
    []
  );

  const runFallback = useCallback(async () => {
    const impl = implRef.current;
    const current = activeRef.current;
    const last = lastRequestRef.current;

    if (!last || last.request.kind !== "url") {
      return;
    }

    const limitProblem = impl.checkLocalAllowance(true);

    if (limitProblem) {
      endActive("import_abandoned", "superseded", { abort: false });
      impl.showProblem(last.request, limitProblem);
      return;
    }

    if (current && !current.terminal && current.request === last.request) {
      // Same correlation id, so the API can reuse the page it already fetched.
      await impl.runAttempt(current, "fallback");
      return;
    }

    await impl.start(last.request, {
      attempt: "fallback",
      skipDuplicateCheck: true,
      source: last.source
    });
  }, [endActive]);

  const retry = useCallback(() => {
    const last = lastRequestRef.current;

    if (!last) {
      return;
    }

    void implRef.current.start(last.request, {
      attempt: last.request.kind === "url" ? "primary" : "fallback",
      skipDuplicateCheck: true,
      source: last.source
    });
  }, []);

  const cancel = useCallback(() => {
    pendingStartRef.current = null;
    endActive("import_cancelled", "user_cancelled", { abort: true });
    safeSetPhase({ status: "idle" });
  }, [endActive, safeSetPhase]);

  const reset = useCallback(() => {
    pendingStartRef.current = null;
    endActive("import_cancelled", "user_reset", { abort: true });
    safeSetPhase({ status: "idle" });
  }, [endActive, safeSetPhase]);

  const restore = useCallback((next: ImportPhase) => safeSetPhase(next), [safeSetPhase]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      pendingStartRef.current = null;
      endActive("import_abandoned", "page_unmounted", { abort: true });
    };
  }, [endActive]);

  return {
    cancel,
    phase,
    quota,
    reset,
    restore,
    retry,
    runFallback,
    startImages,
    startText,
    startUrl
  };
}
