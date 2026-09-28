import { useEffect, useState } from "react";

import { apiClient } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { hasMonthlyQuotaFields } from "../billing/quota-copy";
import { getRemainingImports, webBillingPlans } from "../billing/web-billing";

import type { QuotaStatus } from "@linkdish/api-contracts";

/**
 * How many imports are left, for a quiet "2 of 3 free imports left" in the importer. Signed-in
 * allowances come from the API (GET /billing/usage, then each import's own `quota`); signed-out
 * ones from the on-device counter. Null when there's nothing worth showing (billing off, still
 * loading, or the API didn't say).
 */

export interface ImportUsage {
  remaining: number;
  limit: number;
  /** Monthly allowances refill; the free allowance doesn't. */
  monthly: boolean;
  resetsAt: string | null;
}

export const toImportUsage = (quota: QuotaStatus | null | undefined): ImportUsage | null => {
  if (!quota || quota.meteringMode === "disabled") {
    return null;
  }

  if (hasMonthlyQuotaFields(quota)) {
    return {
      limit: quota.monthlyLimit,
      monthly: true,
      remaining: quota.remainingThisMonth,
      resetsAt: quota.resetsAt
    };
  }

  return { limit: quota.limit, monthly: false, remaining: quota.remaining, resetsAt: null };
};

/** "2 of 3 free imports left", "96 imports left this month", "No free imports left". */
export const formatImportUsage = (usage: ImportUsage): string => {
  if (usage.monthly) {
    return usage.remaining === 0
      ? "No imports left this month"
      : `${usage.remaining} import${usage.remaining === 1 ? "" : "s"} left this month`;
  }

  return usage.remaining === 0
    ? "No free imports left"
    : `${usage.remaining} of ${usage.limit} free imports left`;
};

export interface ImportUsageState {
  usage: ImportUsage | null;
  /** True while the answer is still coming (auth or GET /billing/usage), so a screen can hold
   * the meter's place instead of letting it pop in. */
  pending: boolean;
}

export function useImportUsageState(
  latestQuota: QuotaStatus | null,
  /** Bumped after each import so the on-device counter is read again. */
  version: number
): ImportUsageState {
  const { credentialsKey, isAuthenticated, loading } = useAuth();
  const [serverQuota, setServerQuota] = useState<QuotaStatus | null>(null);
  const [settled, setSettled] = useState(false);

  // Keyed on the credentials (which include the account): it waits for a cached Clerk user's
  // session instead of asking anonymously, and asks again once Clerk signs in.
  useEffect(() => {
    setServerQuota(null);
    setSettled(false);

    if (credentialsKey === null || !isAuthenticated) {
      return;
    }

    const controller = new AbortController();
    apiClient.getBillingUsage({ signal: controller.signal }).then(
      (response) => {
        if (!controller.signal.aborted) {
          setServerQuota(response.billingEnabled ? response.quota : null);
          setSettled(true);
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setSettled(true);
        }
      }
    );

    return () => controller.abort();
  }, [credentialsKey, isAuthenticated]);

  if (loading) {
    return { pending: true, usage: null };
  }

  if (!isAuthenticated) {
    // The version dependency re-reads the on-device counter after each import.
    void version;
    return {
      pending: false,
      usage: {
        limit: webBillingPlans.free.limits.monthlyImports,
        monthly: false,
        remaining: getRemainingImports("free"),
        resetsAt: null
      }
    };
  }

  return {
    pending: !latestQuota && !settled,
    usage: toImportUsage(latestQuota ?? serverQuota)
  };
}

export function useImportUsage(
  latestQuota: QuotaStatus | null,
  /** Bumped after each import so the on-device counter is read again. */
  version: number
): ImportUsage | null {
  return useImportUsageState(latestQuota, version).usage;
}
