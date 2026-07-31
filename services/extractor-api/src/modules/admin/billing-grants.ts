import { randomUUID } from "node:crypto";

import { z } from "zod";

import { getUserByEmail, normalizeEmail } from "../auth/auth-service.js";
import {
  getRevenueCatBillingPlanIdFromSubscriber,
  getRevenueCatEntitlementIdForPlan,
  getRevenueCatSubscriber,
  grantRevenueCatPromotionalEntitlement,
  isRevenueCatEntitlementActive,
  RevenueCatApiError,
  type RevenueCatBillingPlanId
} from "../billing/revenuecat-entitlements.js";
import { setStoreString } from "../storage/upstash-store.js";

const billingGrantVersion = "v1";
const maximumGrantDurationDays = 3650;

const paidPlanSchema = z.enum(["plus", "family"]);

export const adminBillingGrantRequestSchema = z
  .object({
    dryRun: z.boolean().default(false),
    durationDays: z.number().int().positive().max(maximumGrantDurationDays).optional(),
    email: z.string().trim().email().max(254),
    expiresAt: z.string().trim().min(1).max(64).optional(),
    plan: paidPlanSchema
  })
  .refine((request) => request.durationDays != null || request.expiresAt != null, {
    message: "Either durationDays or expiresAt is required.",
    path: ["durationDays"]
  })
  .refine((request) => !(request.durationDays != null && request.expiresAt != null), {
    message: "Use durationDays or expiresAt, not both.",
    path: ["durationDays"]
  });

export type AdminBillingGrantRequest = z.infer<typeof adminBillingGrantRequestSchema>;
type PaidRevenueCatBillingPlanId = z.infer<typeof paidPlanSchema>;

export class AdminBillingGrantError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "AdminBillingGrantError";
  }
}

interface BillingGrantAuditRecord {
  completedAt?: string;
  createdAt: string;
  dryRun: boolean;
  email: string;
  entitlementId: string;
  error?: string;
  expiresAt: string;
  grantedBy: string;
  id: string;
  plan: PaidRevenueCatBillingPlanId;
  status: "failed" | "pending" | "succeeded";
  userId: string;
  verifiedPlan?: RevenueCatBillingPlanId;
}

const billingGrantAuditKey = (grantId: string): string =>
  `linkdish:admin:billing-grant:${billingGrantVersion}:${grantId}`;

const resolveGrantExpiration = (
  request: Pick<AdminBillingGrantRequest, "durationDays" | "expiresAt">,
  now = new Date()
): { endTimeMs: number; expiresAt: string } => {
  const nowMs = now.getTime();
  const endTimeMs =
    request.expiresAt != null
      ? Date.parse(request.expiresAt)
      : nowMs + (request.durationDays ?? 0) * 86_400_000;

  if (!Number.isFinite(endTimeMs)) {
    throw new AdminBillingGrantError("Grant expiration must be a valid date.", 400);
  }

  if (endTimeMs <= nowMs) {
    throw new AdminBillingGrantError("Grant expiration must be in the future.", 400);
  }

  const maximumEndTimeMs = nowMs + maximumGrantDurationDays * 86_400_000;

  if (endTimeMs > maximumEndTimeMs) {
    throw new AdminBillingGrantError(
      `Grant expiration cannot be more than ${maximumGrantDurationDays} days in the future.`,
      400
    );
  }

  return {
    endTimeMs,
    expiresAt: new Date(endTimeMs).toISOString()
  };
};

const writeBillingGrantAuditRecord = async (record: BillingGrantAuditRecord): Promise<void> => {
  await setStoreString(billingGrantAuditKey(record.id), JSON.stringify(record));
};

const toRevenueCatGrantError = (error: unknown): AdminBillingGrantError => {
  if (error instanceof RevenueCatApiError) {
    return new AdminBillingGrantError(
      "RevenueCat could not grant the entitlement.",
      error.statusCode >= 400 && error.statusCode < 500 ? 400 : 502,
      error.responseBody
    );
  }

  if (error instanceof Error) {
    return new AdminBillingGrantError(
      "RevenueCat could not grant the entitlement.",
      502,
      error.message
    );
  }

  return new AdminBillingGrantError("RevenueCat could not grant the entitlement.", 502);
};

export const grantBillingPlanByEmail = async (
  request: AdminBillingGrantRequest,
  options?: {
    grantedBy?: string;
    now?: Date;
  }
): Promise<{
  active: boolean;
  auditId: string | null;
  dryRun: boolean;
  email: string;
  entitlementId: string;
  expiresAt: string;
  plan: PaidRevenueCatBillingPlanId;
  user: {
    id: string;
  };
  verifiedPlan: RevenueCatBillingPlanId | null;
}> => {
  const normalizedEmail = normalizeEmail(request.email);
  const user = await getUserByEmail(normalizedEmail);

  if (!user) {
    throw new AdminBillingGrantError("No active LinkDish account exists for that email.", 404);
  }

  const { endTimeMs, expiresAt } = resolveGrantExpiration(request, options?.now);
  const entitlementId = getRevenueCatEntitlementIdForPlan(request.plan);

  if (request.dryRun) {
    return {
      active: false,
      auditId: null,
      dryRun: true,
      email: normalizedEmail,
      entitlementId,
      expiresAt,
      plan: request.plan,
      user: {
        id: user.id
      },
      verifiedPlan: null
    };
  }

  const auditRecord: BillingGrantAuditRecord = {
    createdAt: new Date(options?.now ?? Date.now()).toISOString(),
    dryRun: false,
    email: normalizedEmail,
    entitlementId,
    expiresAt,
    grantedBy: options?.grantedBy ?? "admin",
    id: randomUUID(),
    plan: request.plan,
    status: "pending",
    userId: user.id
  };

  await writeBillingGrantAuditRecord(auditRecord);

  try {
    await grantRevenueCatPromotionalEntitlement({
      appUserId: user.id,
      endTimeMs,
      entitlementId
    });
    const verifiedSubscriber = await getRevenueCatSubscriber(user.id);
    const verifiedPlan = getRevenueCatBillingPlanIdFromSubscriber(verifiedSubscriber);
    const active = isRevenueCatEntitlementActive(verifiedSubscriber, entitlementId);
    const completedRecord: BillingGrantAuditRecord = {
      ...auditRecord,
      completedAt: new Date().toISOString(),
      status: "succeeded",
      verifiedPlan
    };

    await writeBillingGrantAuditRecord(completedRecord);

    return {
      active,
      auditId: auditRecord.id,
      dryRun: false,
      email: normalizedEmail,
      entitlementId,
      expiresAt,
      plan: request.plan,
      user: {
        id: user.id
      },
      verifiedPlan
    };
  } catch (error) {
    const grantError = toRevenueCatGrantError(error);
    const failedRecord: BillingGrantAuditRecord = {
      ...auditRecord,
      completedAt: new Date().toISOString(),
      error: grantError.detail ?? grantError.message,
      status: "failed"
    };

    await writeBillingGrantAuditRecord(failedRecord).catch((auditError) => {
      console.error("Failed to record failed billing grant audit event.", auditError);
    });

    throw grantError;
  }
};
