import { recordAdminAction, type AdminRequestContext } from "./admin-access.js";
import { grantBillingPlanByEmail, type AdminBillingGrantRequest } from "./billing-grants.js";
import { getAdminUserAccountDetails, type AdminUserLookupQuery } from "./user-accounts.js";

import type { AdminAuditAction, AdminAuditDetail } from "./admin-audit.js";
import type { AdminModelUpdate, ManagedFallbackExtractor } from "./model-control.js";

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
