import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { createWebAnalyticsId } from "../../analytics/session";
import { apiClient } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import {
  getNextQueuedImport,
  markImportDone,
  markImportFailed,
  markImportProcessing,
  recoverStaleImports,
  retryImport,
  type ImportQueueItem
} from "../../data/import-queue-store";
import { getSavedRecipesSnapshot, loadSavedRecipes } from "../../data/library-store";
import { isOnline } from "../../platform/detect-network";
import {
  canStartWebImport,
  canStartWebStrongExtraction,
  spendWebImport,
  spendWebStrongExtraction
} from "../billing/web-billing";
import { isSocialImportUrl } from "../extract/import-input";
import {
  describeImportError,
  describeImportFailure,
  getImportErrorAnalytics
} from "../extract/import-outcome";
import {
  findSavedDuplicate,
  getAnalyticsSourceHost,
  IMPORT_ANALYTICS_ROUTE
} from "../extract/import-shared";
import { getImportSourceType } from "../extract/use-save-import";
import {
  assertCanAddSavedRecipe,
  generateDeterministicId,
  SavedRecipeLimitError,
  saveRecipe,
  syncRecipeToHousehold
} from "../library/saved-recipe-store";

import type { WebBillingTier } from "../billing/web-billing";
import type { ExtractRecipeResponse } from "@linkdish/api-contracts";
import type { V2AnalyticsImportProperties } from "@linkdish/utils";

/**
 * Works through the import queue one item at a time: the duplicate check (no quota spent),
 * the save limit and the signed-out allowance first, then primary extraction, AI help where it
 * runs by itself (social captions, paid plans), and an automatic save. Failures stay in the
 * queue with a plain reason; running out of room or imports pauses the queue instead. The runner
 * never opens UI itself: a pause shows up quietly in the queue panel, and the upgrade sheet opens
 * only when the cook taps it there.
 */

export type QueuePauseReason = "save_limit" | "import_limit" | "offline";

export interface QueueRunnerContext {
  isAuthenticated: boolean;
  tier: WebBillingTier;
  signal: AbortSignal;
}

export type QueueItemOutcome =
  | { status: "done"; recipeId: string; duplicate: boolean }
  | { status: "failed"; message: string }
  | { status: "paused"; reason: QueuePauseReason }
  | { status: "stopped" };

type ImportProperties = V2AnalyticsImportProperties & { source: "in_app" | "share_sheet" };

const NEEDS_AI_MESSAGE = "This one needs AI help. Open it to try.";

const propertiesFor = (item: ImportQueueItem): ImportProperties => {
  const source = item.source ?? "in_app";

  if (!item.url) {
    return { attempt: "fallback", source, source_type: "text" };
  }

  const host = getAnalyticsSourceHost(item.url);
  return {
    attempt: "primary",
    source,
    source_type: source === "share_sheet" ? "share_target" : "url",
    ...(host ? { source_host: host } : {})
  };
};

const isPaid = (tier: WebBillingTier) => tier !== "free";

const extract = (
  item: ImportQueueItem,
  attempt: "primary" | "fallback",
  correlationId: string,
  signal: AbortSignal
): Promise<ExtractRecipeResponse> =>
  item.url
    ? apiClient.extractRecipe({ attempt, correlationId, url: item.url }, { signal })
    : apiClient.extractRecipeFromText(
        { attempt: "fallback", correlationId, text: item.text ?? "" },
        { signal }
      );

/** Processes one queued item. Never throws. */
export async function processImportQueueItem(
  item: ImportQueueItem,
  context: QueueRunnerContext
): Promise<QueueItemOutcome> {
  const { isAuthenticated, signal, tier } = context;

  // 1. Already saved? Nothing to import, nothing spent.
  if (item.url) {
    await loadSavedRecipes();
    const existing = findSavedDuplicate(item.url, getSavedRecipesSnapshot().data);

    if (existing) {
      await markImportDone(item.id, { recipeId: existing.id });
      return { duplicate: true, recipeId: existing.id, status: "done" };
    }
  }

  // 2. Room in the cookbook, before an import is spent on a recipe that can't be kept.
  try {
    await assertCanAddSavedRecipe({ isPremiumUser: isPaid(tier) });
  } catch (error) {
    if (error instanceof SavedRecipeLimitError) {
      return { reason: "save_limit", status: "paused" };
    }
  }

  // 3. The signed-out allowance (signed-in imports are metered by the API).
  const needsStrong = !item.url;

  if (
    !isAuthenticated &&
    (!canStartWebImport(tier).allowed ||
      (needsStrong && !canStartWebStrongExtraction(tier).allowed))
  ) {
    return { reason: "import_limit", status: "paused" };
  }

  if (signal.aborted) {
    return { status: "stopped" };
  }

  await markImportProcessing(item.id);
  const correlationId = createWebAnalyticsId();
  let properties = propertiesFor(item);
  let attempt: "primary" | "fallback" = item.url ? "primary" : "fallback";
  let terminal = false;
  const fail = async (failureProperties: Record<string, string | number>, message: string) => {
    terminal = true;
    trackWebV2AnalyticsEvent({
      correlationId,
      name: "import_failed",
      properties: { ...properties, attempt, ...failureProperties },
      routeOrScreen: IMPORT_ANALYTICS_ROUTE
    });
    await markImportFailed(item.id, message);
  };

  trackWebEvent({
    correlationId,
    eventName: "import_started",
    properties,
    routeOrScreen: IMPORT_ANALYTICS_ROUTE
  });

  try {
    let response = await extract(item, attempt, correlationId, signal);

    if (response.status === "needs_retry") {
      trackWebV2AnalyticsEvent({
        correlationId,
        name: "import_needs_retry",
        properties: { ...properties, attempt, retry_reason: response.reason },
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });

      const recovery = response.recovery;
      const allowAi =
        Boolean(item.url) &&
        attempt === "primary" &&
        (recovery?.allowFallback ?? true) &&
        recovery?.suggestedAction !== "try_another_url" &&
        (isPaid(tier) ||
          response.sourceType === "social" ||
          response.sourceType === "video" ||
          isSocialImportUrl(item.url)) &&
        (isAuthenticated || canStartWebStrongExtraction(tier).allowed);

      if (!allowAi) {
        await fail({ failure_reason: response.reason }, NEEDS_AI_MESSAGE);
        return { message: NEEDS_AI_MESSAGE, status: "failed" };
      }

      attempt = "fallback";
      properties = { ...properties, attempt };
      response = await extract(item, attempt, correlationId, signal);
    }

    if (response.status === "success") {
      terminal = true;
      trackWebV2AnalyticsEvent({
        correlationId,
        name: "import_succeeded",
        properties: {
          ...properties,
          attempt,
          fetch_mode: response.extraction.fetchMode,
          provenance_count: response.extraction.provenance.length,
          strategy: response.extraction.strategy,
          warning_count: response.extraction.warnings.length
        },
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });

      if (!isAuthenticated) {
        spendWebImport(tier);

        if (attempt === "fallback") {
          spendWebStrongExtraction(tier);
        }
      }

      const input = {
        extraction: {
          fetchMode: response.extraction.fetchMode,
          provenance: response.extraction.provenance,
          strategy: response.extraction.strategy,
          warnings: response.extraction.warnings
        },
        recipe: response.recipe,
        sourceUrl: item.url ?? response.recipe.sourceUrl
      };
      const saved = await saveRecipe(input, isPaid(tier));

      if (saved.error === "limit_exceeded") {
        await markImportFailed(item.id, "Your cookbook is full. Make room, then try again.");
        return { reason: "save_limit", status: "paused" };
      }

      if (saved.success && saved.recipe) {
        trackWebV2AnalyticsEvent({
          name: "recipe_saved",
          properties: { source_type: getImportSourceType(input), surface: "import_result" },
          routeOrScreen: IMPORT_ANALYTICS_ROUTE
        });

        if (isAuthenticated) {
          void syncRecipeToHousehold(saved.recipe).catch(() => undefined);
        }
      }

      // A duplicate_prompt means this exact recipe is already saved under the same id.
      const recipeId =
        saved.recipe?.id ?? (await generateDeterministicId(input.sourceUrl, input.recipe.title));
      await markImportDone(item.id, { recipeId });
      return { duplicate: !saved.success, recipeId, status: "done" };
    }

    if (response.status === "needs_retry") {
      await fail({ failure_reason: response.reason }, "We couldn't find the recipe there.");
      return { message: "We couldn't find the recipe there.", status: "failed" };
    }

    const problem = describeImportFailure(response, {
      kind: item.url ? "url" : "text",
      plan: tier
    });

    if (problem.isPlanLimit) {
      terminal = true;
      trackWebV2AnalyticsEvent({
        correlationId,
        name: "import_failed",
        properties: { ...properties, attempt, failure_reason: response.reason },
        routeOrScreen: IMPORT_ANALYTICS_ROUTE
      });
      // Not the link's fault: it waits in the queue for more imports.
      await retryImport(item.id);
      return { reason: "import_limit", status: "paused" };
    }

    await fail({ failure_reason: response.reason }, problem.title);
    return { message: problem.title, status: "failed" };
  } catch (error) {
    if (signal.aborted) {
      if (!terminal) {
        trackWebV2AnalyticsEvent({
          correlationId,
          name: "import_abandoned",
          properties: { ...properties, abandonment_reason: "queue_stopped", attempt },
          routeOrScreen: IMPORT_ANALYTICS_ROUTE
        });
      }

      await retryImport(item.id);
      return { status: "stopped" };
    }

    if (!isOnline()) {
      if (!terminal) {
        trackWebV2AnalyticsEvent({
          correlationId,
          name: "import_failed",
          properties: { ...properties, attempt, ...getImportErrorAnalytics(error) },
          routeOrScreen: IMPORT_ANALYTICS_ROUTE
        });
      }

      await retryImport(item.id);
      return { reason: "offline", status: "paused" };
    }

    if (terminal) {
      // The import itself finished (and was recorded); keeping the recipe didn't work.
      const message = getFriendlyErrorMessage(error, "save");
      await markImportFailed(item.id, message).catch(() => undefined);
      return { message, status: "failed" };
    }

    const problem = describeImportError(error, { kind: item.url ? "url" : "text", plan: tier });
    await fail(getImportErrorAnalytics(error), problem.title).catch(() => undefined);
    return { message: problem.title, status: "failed" };
  }
}

export interface QueueRunResult {
  /** Why the run stopped early (null when every queued item was handled). */
  paused: QueuePauseReason | null;
  processed: number;
}

/** Runs the queue until it's empty, paused or stopped. */
export async function runImportQueue(context: QueueRunnerContext): Promise<QueueRunResult> {
  await recoverStaleImports().catch(() => 0);
  let processed = 0;

  while (!context.signal.aborted) {
    if (!isOnline()) {
      return { paused: "offline", processed };
    }

    const next = await getNextQueuedImport();

    if (!next) {
      return { paused: null, processed };
    }

    const outcome = await processImportQueueItem(next, context);

    if (outcome.status === "paused") {
      return { paused: outcome.reason, processed };
    }

    if (outcome.status === "stopped") {
      return { paused: null, processed };
    }

    processed += 1;
  }

  return { paused: null, processed };
}
