import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { createWebAnalyticsId } from "../../analytics/session";
import { apiClient } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import {
  claimNextQueuedImport,
  holdImportForSave,
  IMPORT_CLAIM_RENEW_MS,
  markImportDone,
  markImportFailed,
  markImportProcessing,
  recoverStaleImports,
  renewImportClaim,
  retryImport,
  type ImportQueueItem,
  type ImportQueuePendingSave
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
import { markRecipeSaved } from "../install/install-eligibility";
import {
  assertCanAddSavedRecipe,
  generateDeterministicId,
  SavedRecipeLimitError,
  saveRecipe,
  syncRecipeToHousehold
} from "../library/saved-recipe-store";

import type { WebBillingTier } from "../billing/web-billing";
import type { SaveRecipeInput } from "../library/saved-recipe-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeResponse } from "@linkdish/api-contracts";
import type { V2AnalyticsImportProperties } from "@linkdish/utils";

/**
 * Works through the import queue one item at a time: the duplicate check (no quota spent),
 * the save limit and the signed-out allowance first, then primary extraction, AI help where it
 * runs by itself (social captions, paid plans), and an automatic save. Failures stay in the
 * queue with a plain reason; running out of room or imports pauses the queue instead. The runner
 * never opens UI itself: a pause shows up quietly in the queue panel, and the upgrade sheet opens
 * only when the cook taps it there.
 *
 * An import that worked but whose recipe couldn't be kept (the cookbook filled up meanwhile, or
 * saving failed) is paid for, so its item keeps the recipe (see ImportQueuePendingSave), and from
 * then on is only ever saved: no import is spent, or charged, on it twice.
 *
 * Each item is claimed for this tab before any work starts (see claimNextQueuedImport), so a
 * second tab working through the same queue never imports it again.
 */

export type QueuePauseReason = "save_limit" | "import_limit" | "offline";

export interface QueueRunnerContext {
  isAuthenticated: boolean;
  tier: WebBillingTier;
  signal: AbortSignal;
  /** Whose claims these are. Defaults to this tab's id. */
  owner?: string | undefined;
}

export type QueueItemOutcome =
  | { status: "done"; recipeId: string; duplicate: boolean }
  | { status: "failed"; message: string }
  | { status: "paused"; reason: QueuePauseReason }
  | { status: "stopped" }
  /** Another tab claimed the item (this tab's claim lapsed), or it was removed, meanwhile. */
  | { status: "skipped" };

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

let tabOwnerId: string | undefined;

/** Identifies this tab's claims on queue items (a new id per page load). */
const getTabOwnerId = (): string => (tabOwnerId ??= createWebAnalyticsId());

const extract = (
  item: ImportQueueItem,
  attempt: "primary" | "fallback",
  correlationId: string,
  signal: AbortSignal
): Promise<ExtractRecipeResponse> =>
  item.url
    ? apiClient.extractRecipe({ attempt, correlationId, url: item.url }, { signal })
    : apiClient.extractRecipeFromText(
        {
          attempt: "fallback",
          correlationId,
          text: item.text ?? "",
          ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {})
        },
        { signal }
      );

/** The cookbook as stored. Throws when it can't be read (the load itself never rejects). */
const readCookbook = async (): Promise<readonly WebSavedRecipe[]> => {
  await loadSavedRecipes();
  const cookbook = getSavedRecipesSnapshot();

  if (cookbook.status !== "ready") {
    throw cookbook.error instanceof Error || cookbook.error instanceof DOMException
      ? cookbook.error
      : new Error("The cookbook couldn't be read.", { cause: cookbook.error });
  }

  return cookbook.data;
};

/**
 * Whether the cookbook has room for one more recipe. Only a full cookbook says no; anything else
 * (storage that can't be read) throws, and stops the run.
 */
const hasRoomToSave = async (tier: WebBillingTier): Promise<boolean> => {
  try {
    await assertCanAddSavedRecipe({ isPremiumUser: isPaid(tier) });
    return true;
  } catch (error) {
    if (error instanceof SavedRecipeLimitError) {
      return false;
    }

    throw error;
  }
};

/**
 * Saves an imported recipe and finishes its item. Should the cookbook be full after all (another
 * tab took the last free slot since the room check), the item goes back in the queue with the
 * recipe, in the same write that lets it go: the import is paid for, so making room saves it as
 * it is, never importing it again.
 */
async function keepImportedRecipe(
  item: ImportQueueItem,
  imported: ImportQueuePendingSave,
  context: QueueRunnerContext
): Promise<QueueItemOutcome> {
  const { isAuthenticated, owner, tier } = context;
  const input: SaveRecipeInput = {
    extraction: imported.extraction,
    recipe: imported.recipe,
    sourceUrl: imported.sourceUrl
  };
  const saved = await saveRecipe(input, isPaid(tier));

  if (saved.error === "limit_exceeded") {
    await holdImportForSave(item.id, imported, owner);
    return { reason: "save_limit", status: "paused" };
  }

  if (saved.success && saved.recipe) {
    trackWebV2AnalyticsEvent({
      correlationId: imported.correlationId,
      name: "recipe_saved",
      properties: { source_type: getImportSourceType(input), surface: "import_result" },
      routeOrScreen: IMPORT_ANALYTICS_ROUTE
    });
    markRecipeSaved();

    if (isAuthenticated) {
      void syncRecipeToHousehold(saved.recipe).catch(() => undefined);
    }
  }

  // A duplicate_prompt means this exact recipe is already saved under the same id.
  const recipeId =
    saved.recipe?.id ?? (await generateDeterministicId(input.sourceUrl, input.recipe.title));
  await markImportDone(item.id, { recipeId }, owner);
  return { duplicate: !saved.success, recipeId, status: "done" };
}

/**
 * Saves the recipe an earlier run imported but couldn't keep (see ImportQueuePendingSave). That
 * import is paid for: nothing is imported or spent now. A recipe saved meanwhile (another tab
 * imported the same link) finishes the item; a cookbook that is still full pauses it again.
 */
async function savePendingImport(
  item: ImportQueueItem,
  pending: ImportQueuePendingSave,
  context: QueueRunnerContext
): Promise<QueueItemOutcome> {
  const { owner, signal, tier } = context;
  const cookbook = await readCookbook();
  const id = await generateDeterministicId(pending.sourceUrl, pending.recipe.title);
  // Only a link is matched page by page: two texts from one page can be two recipes.
  const existing =
    cookbook.find((recipe) => recipe.id === id) ??
    (item.url ? findSavedDuplicate(item.url, cookbook) : undefined);

  if (existing) {
    await markImportDone(item.id, { recipeId: existing.id }, owner);
    return { duplicate: true, recipeId: existing.id, status: "done" };
  }

  if (!(await hasRoomToSave(tier))) {
    await retryImport(item.id, owner);
    return { reason: "save_limit", status: "paused" };
  }

  if (signal.aborted) {
    await retryImport(item.id, owner);
    return { status: "stopped" };
  }

  if (!(await markImportProcessing(item.id, owner))) {
    return { status: "skipped" };
  }

  try {
    return await keepImportedRecipe(item, pending, context);
  } catch (error) {
    // Keeping it didn't work (storage): it stays failed with the recipe, for Retry to save.
    const message = getFriendlyErrorMessage(error, "save");
    await markImportFailed(item.id, message, owner).catch(() => undefined);
    return { message, status: "failed" };
  }
}

/**
 * Processes one queued item, claimed for `context.owner`. Throws only on storage trouble while
 * nothing has been spent (e.g. the cookbook can't be read before the import starts, or before a
 * recipe imported earlier is saved); the caller then lets the item go, with any such recipe.
 */
export async function processImportQueueItem(
  item: ImportQueueItem,
  context: QueueRunnerContext
): Promise<QueueItemOutcome> {
  const { isAuthenticated, owner, signal, tier } = context;

  // Imported already, and paid for: it only needs saving.
  if (item.pendingSave) {
    return savePendingImport(item, item.pendingSave, context);
  }

  // 1. Already saved? Nothing to import, nothing spent. (An unreadable cookbook throws: importing
  // now could spend one on a recipe we have.) Pasted text is imported as it is online, even with
  // the page it came from (that page can hold more than one recipe): saving it finds the same
  // recipe from that page by its id.
  if (item.url) {
    const existing = findSavedDuplicate(item.url, await readCookbook());

    if (existing) {
      await markImportDone(item.id, { recipeId: existing.id }, owner);
      return { duplicate: true, recipeId: existing.id, status: "done" };
    }
  }

  // 2. Room in the cookbook, before an import is spent on a recipe that can't be kept.
  if (!(await hasRoomToSave(tier))) {
    await retryImport(item.id, owner);
    return { reason: "save_limit", status: "paused" };
  }

  // 3. The signed-out allowance (signed-in imports are metered by the API).
  const needsStrong = !item.url;

  if (
    !isAuthenticated &&
    (!canStartWebImport(tier).allowed ||
      (needsStrong && !canStartWebStrongExtraction(tier).allowed))
  ) {
    await retryImport(item.id, owner);
    return { reason: "import_limit", status: "paused" };
  }

  if (signal.aborted) {
    await retryImport(item.id, owner);
    return { status: "stopped" };
  }

  if (!(await markImportProcessing(item.id, owner))) {
    return { status: "skipped" };
  }

  const correlationId = createWebAnalyticsId();
  let properties = propertiesFor(item);
  let attempt: "primary" | "fallback" = item.url ? "primary" : "fallback";
  let terminal = false;
  /** Set once the import worked (and is paid for): the item must not let go of it from then on. */
  let imported: ImportQueuePendingSave | undefined;
  const release = () =>
    imported ? holdImportForSave(item.id, imported, owner) : retryImport(item.id, owner);
  const fail = async (failureProperties: Record<string, string | number>, message: string) => {
    terminal = true;
    trackWebV2AnalyticsEvent({
      correlationId,
      name: "import_failed",
      properties: { ...properties, attempt, ...failureProperties },
      routeOrScreen: IMPORT_ANALYTICS_ROUTE
    });
    await markImportFailed(item.id, message, owner);
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

      imported = {
        correlationId,
        extraction: {
          fetchMode: response.extraction.fetchMode,
          provenance: response.extraction.provenance,
          strategy: response.extraction.strategy,
          warnings: response.extraction.warnings
        },
        recipe: response.recipe,
        // As the importer saves it: the link, or the page pasted text came from.
        sourceUrl: item.url ?? item.sourceUrl ?? response.recipe.sourceUrl
      };
      return await keepImportedRecipe(item, imported, context);
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
      await retryImport(item.id, owner);
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

      await release();
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

      await release();
      return { reason: "offline", status: "paused" };
    }

    if (terminal) {
      // The import itself finished (and was recorded); keeping the recipe didn't work. The item
      // keeps the recipe, so Retry saves it without importing it again.
      const message = getFriendlyErrorMessage(error, "save");
      await markImportFailed(item.id, message, owner, imported).catch(() => undefined);
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
  const owner = context.owner ?? getTabOwnerId();
  const itemContext = { ...context, owner };
  await recoverStaleImports().catch(() => 0);
  let processed = 0;

  while (!context.signal.aborted) {
    if (!isOnline()) {
      return { paused: "offline", processed };
    }

    const next = await claimNextQueuedImport(owner);

    if (!next) {
      return { paused: null, processed };
    }

    // Keep the claim fresh while the import runs, so a slow one is never mistaken for an
    // abandoned tab's and imported again elsewhere.
    const renewal = setInterval(() => {
      void renewImportClaim(next.id, owner).catch(() => undefined);
    }, IMPORT_CLAIM_RENEW_MS);
    let outcome: QueueItemOutcome;

    try {
      outcome = await processImportQueueItem(next, itemContext);
    } catch (error) {
      // Storage trouble before the import started (nothing spent): let the item go for the next
      // run (a recipe it waits to save stays with it), and stop this one.
      await retryImport(next.id, owner).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(renewal);
    }

    if (outcome.status === "skipped") {
      continue;
    }

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
