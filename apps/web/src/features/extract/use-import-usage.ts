import { useEffect, useState, useSyncExternalStore } from "react";

import { apiClient } from "../../api/client";
import { asAccount } from "../../api/request-binding";
import { getCurrentAccount } from "../../auth/account-scope";
import { useAuth } from "../../auth/AuthProvider";
import { hasMonthlyQuotaFields } from "../billing/quota-copy";
import { getRemainingImports, webBillingPlans } from "../billing/web-billing";

import { getImportUsageGeneration, subscribeImportUsage } from "./import-usage-signal";

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

/** Orders the quotas this hook sees, so the most recent answer for an account wins. */
let answerSequence = 0;

export function useImportUsageState(
  latestQuota: QuotaStatus | null,
  /** Bumped after each import so the on-device counter is read again. */
  version: number
): ImportUsageState {
  const { credentialsKey, isAuthenticated, loading } = useAuth();
  // Bumped when the import queue imports links in the background.
  const generation = useSyncExternalStore(
    subscribeImportUsage,
    getImportUsageGeneration,
    getImportUsageGeneration
  );
  /** The server's answer, the credentials it was asked with, and when it arrived. */
  const [server, setServer] = useState<{
    key: string | null;
    quota: QuotaStatus | null;
    sequence: number;
    settled: boolean;
  }>({ key: null, quota: null, sequence: 0, settled: false });
  /** The last import's quota, with the credentials it was imported under. */
  const [latest, setLatest] = useState<{
    key: string | null;
    quota: QuotaStatus | null;
    sequence: number;
  }>({ key: credentialsKey, quota: latestQuota, sequence: 0 });

  useEffect(() => {
    answerSequence += 1;
    setLatest({ key: credentialsKey, quota: latestQuota, sequence: answerSequence });
    // Only a new import's quota is recorded; a credentials change must not adopt the old one.
  }, [latestQuota]);

  // Keyed on the credentials (which include the account): it waits for a cached Clerk user's
  // session instead of asking anonymously, and asks again once Clerk signs in, or when the
  // import queue has imported something. A refresh for the same account keeps showing the
  // answer it has until the new one arrives.
  useEffect(() => {
    setServer((current) =>
      current.key === credentialsKey
        ? current
        : { key: credentialsKey, quota: null, sequence: 0, settled: false }
    );

    if (credentialsKey === null || !isAuthenticated) {
      return;
    }

    const controller = new AbortController();
    // Asked only as the account signed in now, never as one Clerk switches to meanwhile.
    asAccount(getCurrentAccount(), () =>
      apiClient.getBillingUsage({ signal: controller.signal })
    ).then(
      (response) => {
        if (!controller.signal.aborted) {
          answerSequence += 1;
          setServer({
            key: credentialsKey,
            quota: response.billingEnabled ? response.quota : null,
            sequence: answerSequence,
            settled: true
          });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setServer((current) =>
            current.key === credentialsKey
              ? { ...current, settled: true }
              : { key: credentialsKey, quota: null, sequence: 0, settled: true }
          );
        }
      }
    );

    return () => controller.abort();
  }, [credentialsKey, generation, isAuthenticated]);

  if (loading) {
    return { pending: true, usage: null };
  }

  if (!isAuthenticated) {
    // The version and generation re-read the on-device counter after each import.
    void version;
    void generation;
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

  // Only this account's answers count, never another account's, even for a render. A quota
  // that just arrived from an import (not recorded yet) is this account's and the newest.
  const current =
    server.key === credentialsKey ? server : { quota: null, sequence: 0, settled: false };
  const fresh = latestQuota !== null && latestQuota !== latest.quota;
  const imported = fresh
    ? { quota: latestQuota, sequence: Number.POSITIVE_INFINITY }
    : latest.key === credentialsKey && latest.quota
      ? latest
      : null;
  const quota =
    imported && (!current.quota || imported.sequence > current.sequence)
      ? imported.quota
      : current.quota;

  return {
    pending: !imported && !current.settled,
    usage: toImportUsage(quota)
  };
}

export function useImportUsage(
  latestQuota: QuotaStatus | null,
  /** Bumped after each import so the on-device counter is read again. */
  version: number
): ImportUsage | null {
  return useImportUsageState(latestQuota, version).usage;
}
