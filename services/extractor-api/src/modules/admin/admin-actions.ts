import { recordAdminAction, type AdminRequestContext } from "./admin-access.js";
import { grantBillingPlanByEmail, type AdminBillingGrantRequest } from "./billing-grants.js";
import { getAdminUserAccountDetails, type AdminUserLookupQuery } from "./user-accounts.js";

import type { AdminAuditAction, AdminAuditDetail } from "./admin-audit.js";
import type { AdminModelUpdate, ManagedFallbackExtractor } from "./model-control.js";
import type { ExtractorRuntime } from "../extract/types.js";

/*
 * The audited admin operations, shared by the Fastify routes and the Vercel adapter so both
 * write the same audit entries. Each records success or failure, then returns or rethrows.
 */
const withAudit = async <T>(
  context: AdminRequestContext,
  action: AdminAuditAction,
  detail: AdminAuditDetail,
  run: () => Promise<T>,
  successDetail?: (result: T) => AdminAuditDetail
): Promise<T> => {
  try {
    const result = await run();
    await recordAdminAction(context, action, "success", {
      ...detail,
      ...successDetail?.(result)
    });
    return result;
  } catch (error) {
    await recordAdminAction(context, action, "failure", {
      ...detail,
      error: error instanceof Error ? error.message.slice(0, 300) : "Unknown error"
    });
    throw error;
  }
};

export const lookupAdminUserAccount = (context: AdminRequestContext, query: AdminUserLookupQuery) =>
  withAudit(context, "user.lookup", { email: query.email }, () =>
    getAdminUserAccountDetails(query)
  );

export const grantAdminBillingPlan = (
  context: AdminRequestContext,
  request: AdminBillingGrantRequest
) =>
  withAudit(
    context,
    "billing.grant",
    {
      dryRun: request.dryRun,
      durationDays: request.durationDays ?? null,
      email: request.email,
      expiresAt: request.expiresAt ?? null,
      plan: request.plan
    },
    () => grantBillingPlanByEmail(request, { grantedBy: `admin-api:${context.actor}` }),
    (grant) => ({ grantAuditId: grant.auditId, verifiedPlan: grant.verifiedPlan })
  );

export const updateAdminModelSettings = (
  context: AdminRequestContext,
  extractor: ManagedFallbackExtractor,
  update: AdminModelUpdate
) =>
  withAudit(
    context,
    "llm.update",
    { model: update.model ?? null, provider: update.provider ?? null },
    () => extractor.updateSettings(update)
  );

export const resetAdminModelSettings = (
  context: AdminRequestContext,
  extractor: ManagedFallbackExtractor
) => withAudit(context, "llm.reset", {}, () => extractor.resetSettingsToEnv());

export class AdminRecipeRemovalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "AdminRecipeRemovalError";
  }
}

const parseRecipeLink = (url: string | null): string => {
  try {
    const parsed = new URL(url ?? "");

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // Reported below.
  }

  throw new AdminRecipeRemovalError("Pass the recipe link as ?url=https://...", 400);
};

/*
 * Removes a link's recipe from LinkDish's shared copies (a takedown request, a bad entry): the
 * recipe archive and the short-lived result cache, and keeps the link out of both from then on
 * (recipe_archive_removals). Recipes people already saved stay in their cookbooks; later imports
 * of the link read the site each time.
 */
/*
 * An import that read the archive just before the removal may still be copying that entry into
 * the result cache (its write lands within the cache store's 1.5 s timeout). The removal marker
 * is committed first, so nothing starts such a copy afterwards; the cache key is deleted again
 * once any copy already under way has landed.
 */
export const recipeRemovalCacheSettleMs = 3_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const removeAdminArchivedRecipe = (
  context: AdminRequestContext,
  runtime: Pick<ExtractorRuntime, "extractionCache" | "recipeArchive">,
  rawUrl: string | null,
  { cacheSettleMs = recipeRemovalCacheSettleMs }: { cacheSettleMs?: number } = {}
) => {
  const url = parseRecipeLink(rawUrl);

  return withAudit(
    context,
    "recipe.remove",
    { url: url.slice(0, 300) },
    async () => {
      const archived = (await runtime.recipeArchive?.remove(url)) ?? false;
      await runtime.extractionCache?.remove(url);

      if (runtime.recipeArchive && runtime.extractionCache) {
        await wait(cacheSettleMs);
        await runtime.extractionCache.remove(url);
      }

      return {
        url,
        archiveConfigured: Boolean(runtime.recipeArchive),
        removedFromArchive: archived
      };
    },
    (result) => ({ removedFromArchive: result.removedFromArchive })
  );
};
