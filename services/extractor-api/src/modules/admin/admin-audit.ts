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
/* Hard cap so a flood of failed sign-ins cannot grow the set without bound. */
const adminAuditMaxEntries = 2_000;

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

  console.info("[admin-audit]", JSON.stringify(record));

  try {
    const results = await runStoreTransaction([
      ["ZADD", adminAuditKey, String(now.getTime()), JSON.stringify(record)],
      ["ZREMRANGEBYSCORE", adminAuditKey, "0", String(now.getTime() - retentionMs)],
      ["ZREMRANGEBYRANK", adminAuditKey, "0", String(-(adminAuditMaxEntries + 1))]
    ]);
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

export const listAdminAuditEvents = async (limit = 50): Promise<AdminAuditEvent[]> => {
  const members = await getStoreSortedSetMembersWithScores(
    adminAuditKey,
    0,
    Math.max(0, limit - 1),
    "desc"
  );

  return members.flatMap(({ member }) => {
    try {
      const parsed: unknown = JSON.parse(member);
      return isAdminAuditEvent(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
};
