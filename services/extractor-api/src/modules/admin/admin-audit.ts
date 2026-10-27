import { randomUUID } from "node:crypto";

import { extractorApiEnv } from "../../config/env.js";
import {
  getStoreSortedSetMembersWithScores,
  runStoreTransaction
} from "../storage/upstash-store.js";

export type AdminAuditAction =
  "auth.failed" | "auth.locked" | "billing.grant" | "llm.reset" | "llm.update" | "user.lookup";

export type AdminAuditOutcome = "denied" | "failure" | "success";

export type AdminAuditDetail = Record<string, boolean | number | string | null>;

export interface AdminAuditEvent {
  action: AdminAuditAction;
  /* The admin user's name from ADMIN_DASHBOARD_TOKENS; null when authentication failed. */
  actor: string | null;
  at: string;
  detail?: AdminAuditDetail;
  id: string;
  ip: string;
  outcome: AdminAuditOutcome;
}

const adminAuditKey = "linkdish:admin:audit:v1";
/*
 * Sign-in failures live in their own set so a flood of them (from many networks, each under
 * the lockout) cannot trim real admin actions out of the log. Each set is capped separately.
 */
const adminAuthAuditKey = "linkdish:admin:audit:v1:auth";
const adminAuditMaxEntries = 2_000;

const getAuditKey = (action: AdminAuditAction): string =>
  action.startsWith("auth.") ? adminAuthAuditKey : adminAuditKey;

/**
 * Appends one event to the admin audit log (an Upstash sorted set scored by time, trimmed by
 * age and size) and mirrors it to the function log, so the record survives a store outage.
 * Never throws: an audit write failure must not turn a completed admin action into an error.
 */
export const recordAdminAuditEvent = async (
  event: Omit<AdminAuditEvent, "at" | "id">,
  now = new Date()
): Promise<AdminAuditEvent> => {
  const record: AdminAuditEvent = {
    ...event,
    at: now.toISOString(),
    id: randomUUID()
  };
  const retentionMs = extractorApiEnv.ADMIN_AUDIT_RETENTION_DAYS * 86_400_000;

  const key = getAuditKey(record.action);

  console.info("[admin-audit]", JSON.stringify(record));

  try {
    const results = await runStoreTransaction(
      [
        ["ZADD", key, String(now.getTime()), JSON.stringify(record)],
        ["ZREMRANGEBYSCORE", key, "0", String(now.getTime() - retentionMs)],
        ["ZREMRANGEBYRANK", key, "0", String(-(adminAuditMaxEntries + 1))],
        /* A set that goes quiet for the whole retention period is dropped outright. */
        ["EXPIRE", key, String(extractorApiEnv.ADMIN_AUDIT_RETENTION_DAYS * 86_400)]
      ],
      { timeoutMs: 2_000 }
    );
    const failed = results.find((result) => result.error);

    if (failed) {
      console.error("Failed to write admin audit event.", failed.error);
    }
  } catch (error) {
    console.error("Failed to write admin audit event.", error);
  }

  return record;
};

const isAdminAuditEvent = (value: unknown): value is AdminAuditEvent =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AdminAuditEvent).id === "string" &&
  typeof (value as AdminAuditEvent).action === "string" &&
  typeof (value as AdminAuditEvent).at === "string";

const parseAuditEvent = (member: string): AdminAuditEvent[] => {
  try {
    const parsed: unknown = JSON.parse(member);
    return isAdminAuditEvent(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
};

/* Newest first across both sets. */
export const listAdminAuditEvents = async (limit = 50): Promise<AdminAuditEvent[]> => {
  const stop = Math.max(0, limit - 1);
  const [actions, signIns] = await Promise.all([
    getStoreSortedSetMembersWithScores(adminAuditKey, 0, stop, "desc"),
    getStoreSortedSetMembersWithScores(adminAuthAuditKey, 0, stop, "desc")
  ]);

  /* Trimming only runs on writes, so a quiet set can still hold entries past retention. */
  const cutoffMs = Date.now() - extractorApiEnv.ADMIN_AUDIT_RETENTION_DAYS * 86_400_000;

  return [...actions, ...signIns]
    .filter((entry) => entry.score >= cutoffMs)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .flatMap(({ member }) => parseAuditEvent(member));
};
