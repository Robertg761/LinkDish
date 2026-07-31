import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";

import { extractorApiEnv } from "../../config/env.js";

import type {
  AnalyticsEventInput,
  AnalyticsPlatform,
  QuotaMeteringMode
} from "../../../../../packages/api-contracts/src/index.js";
import type { ExtractionLogContext } from "../extract/types.js";

interface AnalyticsWriteEvent extends AnalyticsEventInput {
  accountUserHash?: string;
}

interface AnalyticsExtractionEventInput {
  extraction: Omit<ExtractionLogContext, "latencyMs"> | null;
  billingPlan: "free" | "plus" | "family" | "disabled" | "unknown";
  latencyMs: number;
  meteringMode: QuotaMeteringMode;
  platform: AnalyticsPlatform;
  occurredAt?: string;
  anonymousId?: string;
  sessionId?: string;
  accountUserHash?: string;
  appVersion?: string;
  buildNumber?: string;
  correlationId?: string;
  blockedReason?: string;
}

export interface AnalyticsSummaryMetric {
  label: string;
  value: number;
  detail?: string;
}

export interface AnalyticsDimensionCount {
  label: string;
  count: number;
  failureCount?: number;
}

export interface AnalyticsRecentFailure {
  occurredAt: string;
  reason: string;
  sourceHostname: string | null;
  platform: string;
  appVersion: string | null;
  buildNumber: string | null;
  visitorAlias: string | null;
  sessionAlias: string | null;
  correlationId: string | null;
}

export interface AnalyticsFailureDrilldown {
  total: number;
  distinctVisitors: number;
  distinctSessions: number;
  byReason: Record<string, number>;
  bySourceHostname: Record<string, number>;
  byPlatform: Record<string, number>;
  byBuild: Record<string, number>;
  byVisitor: Record<string, number>;
  bySession: Record<string, number>;
  recent: AnalyticsRecentFailure[];
}

export interface AnalyticsDashboardSummary {
  configured: boolean;
  enabled: boolean;
  source: "memory" | "postgres" | "disabled";
  generatedAt: string;
  windowDays: number;
  totals: {
    events: number;
    uniqueVisitors: number;
    extractionEvents: number;
    extractionSuccessRate: number;
    errors: number;
  };
  byPlatform: Record<string, number>;
  byEventName: Record<string, number>;
  extractionByStatus: Record<string, number>;
  topSourceHostnames: AnalyticsDimensionCount[];
  failureDrilldown: AnalyticsFailureDrilldown;
  notes: string[];
}

const memoryEvents: AnalyticsWriteEvent[] = [];
const memoryExtractions: AnalyticsExtractionEventInput[] = [];
let pool: Pool | null = null;
let schemaReady = false;

const enabled = (): boolean => extractorApiEnv.ANALYTICS_ENABLED;
const configured = (): boolean => Boolean(extractorApiEnv.ANALYTICS_DATABASE_URL);

const getPool = (): Pool => {
  if (!extractorApiEnv.ANALYTICS_DATABASE_URL) {
    throw new Error("ANALYTICS_DATABASE_URL is not configured.");
  }

  pool ??= new Pool({
    connectionString: extractorApiEnv.ANALYTICS_DATABASE_URL,
    max: 4,
    ssl: extractorApiEnv.ANALYTICS_DATABASE_URL.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false }
  });

  return pool;
};

const ensureSchema = async (): Promise<void> => {
  if (schemaReady || !enabled() || !configured()) {
    return;
  }

  await getPool().query(`
    create table if not exists analytics_events (
      id uuid primary key,
      occurred_at timestamptz not null,
      received_at timestamptz not null default now(),
      platform text not null,
      event_name text not null,
      anonymous_id uuid,
      session_id uuid,
      account_user_hash text,
      correlation_id uuid,
      request_id text,
      app_version text,
      build_number text,
      route_or_screen text,
      referrer_hostname text,
      utm_source text,
      utm_medium text,
      utm_campaign text,
      device_class text,
      os_name text,
      browser_name text,
      properties jsonb not null default '{}'::jsonb
    );

    create index if not exists analytics_events_time_idx
      on analytics_events (occurred_at desc);
    create index if not exists analytics_events_platform_time_idx
      on analytics_events (platform, occurred_at desc);
    create index if not exists analytics_events_name_time_idx
      on analytics_events (event_name, occurred_at desc);
    create unique index if not exists analytics_events_request_id_unique_idx
      on analytics_events (request_id)
      where request_id is not null;

    create table if not exists extraction_analytics (
      id uuid primary key,
      occurred_at timestamptz not null,
      received_at timestamptz not null default now(),
      platform text not null,
      anonymous_id uuid,
      session_id uuid,
      account_user_hash text,
      correlation_id uuid,
      app_version text,
      build_number text,
      source_hostname text,
      source_type text not null,
      status text not null,
      attempt text not null,
      strategy text not null,
      fetch_mode text,
      fallback_provider text,
      confidence_score numeric,
      latency_ms integer not null,
      billing_plan text,
      blocked_reason text,
      error_code text,
      properties jsonb not null default '{}'::jsonb
    );

    create index if not exists extraction_analytics_time_idx
      on extraction_analytics (occurred_at desc);
    create index if not exists extraction_analytics_platform_time_idx
      on extraction_analytics (platform, occurred_at desc);
    create index if not exists extraction_analytics_status_time_idx
      on extraction_analytics (status, occurred_at desc);
    create index if not exists extraction_analytics_source_time_idx
      on extraction_analytics (source_hostname, occurred_at desc);

    alter table analytics_events
      add column if not exists correlation_id uuid;
    alter table extraction_analytics
      add column if not exists correlation_id uuid;
    alter table extraction_analytics
      add column if not exists app_version text;
    alter table extraction_analytics
      add column if not exists build_number text;

    create index if not exists analytics_events_correlation_idx
      on analytics_events (correlation_id)
      where correlation_id is not null;
    create index if not exists extraction_analytics_correlation_idx
      on extraction_analytics (correlation_id)
      where correlation_id is not null;

    create table if not exists error_analytics (
      id uuid primary key,
      occurred_at timestamptz not null,
      received_at timestamptz not null default now(),
      platform text not null,
      source text not null,
      severity text not null,
      error_fingerprint text not null,
      error_code text,
      message_class text,
      app_version text,
      build_number text,
      route_or_screen text,
      account_user_hash text,
      anonymous_id uuid,
      session_id uuid,
      provider_event_url text,
      properties jsonb not null default '{}'::jsonb
    );

    create table if not exists daily_analytics_rollups (
      date date not null,
      platform text not null,
      metric_name text not null,
      dimension_key text,
      dimension_value text,
      count bigint not null default 0,
      numeric_value numeric,
      primary key (date, platform, metric_name, dimension_key, dimension_value)
    );

    create table if not exists external_store_metrics (
      id uuid primary key,
      date date not null,
      provider text not null,
      metric_name text not null,
      value numeric not null,
      dimensions jsonb not null default '{}'::jsonb,
      imported_at timestamptz not null default now(),
      source text not null
    );
  `);

  schemaReady = true;
};

const parseOccurredAt = (value: string | undefined): Date => {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const pushMemoryEvent = (event: AnalyticsWriteEvent): boolean => {
  if (
    event.requestId &&
    memoryEvents.some((existingEvent) => existingEvent.requestId === event.requestId)
  ) {
    return false;
  }

  memoryEvents.push(event);

  if (memoryEvents.length > 2_000) {
    memoryEvents.splice(0, memoryEvents.length - 2_000);
  }

  return true;
};

const getErrorFingerprint = (event: AnalyticsWriteEvent): string => {
  const message =
    typeof event.properties.message === "string" ? event.properties.message : event.eventName;
  return `${event.platform}:${event.routeOrScreen ?? "unknown"}:${message.slice(0, 120)}`;
};

const pushMemoryExtraction = (event: AnalyticsExtractionEventInput): void => {
  memoryExtractions.push(event);

  if (memoryExtractions.length > 2_000) {
    memoryExtractions.splice(0, memoryExtractions.length - 2_000);
  }
};

export const writeAnalyticsEvents = async (events: AnalyticsWriteEvent[]): Promise<number> => {
  if (!enabled()) {
    return 0;
  }

  if (!configured()) {
    return events.filter((event) => pushMemoryEvent(event)).length;
  }

  await ensureSchema();
  let accepted = 0;

  for (const event of events) {
    const insertResult = await getPool().query(
      `
        insert into analytics_events (
          id, occurred_at, platform, event_name, anonymous_id, session_id, account_user_hash,
          correlation_id, request_id, app_version, build_number, route_or_screen, referrer_hostname,
          utm_source, utm_medium, utm_campaign, device_class, os_name, browser_name, properties
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb)
        on conflict do nothing
      `,
      [
        randomUUID(),
        parseOccurredAt(event.occurredAt).toISOString(),
        event.platform,
        event.eventName,
        event.anonymousId ?? null,
        event.sessionId ?? null,
        event.accountUserHash ?? null,
        event.correlationId ?? null,
        event.requestId ?? null,
        event.appVersion ?? null,
        event.buildNumber ?? null,
        event.routeOrScreen ?? null,
        event.referrerHostname ?? null,
        event.utmSource ?? null,
        event.utmMedium ?? null,
        event.utmCampaign ?? null,
        event.deviceClass ?? null,
        event.osName ?? null,
        event.browserName ?? null,
        JSON.stringify(event.properties)
      ]
    );

    if ((insertResult.rowCount ?? 0) === 0) {
      continue;
    }

    accepted += 1;
    pushMemoryEvent(event);

    if (event.eventName === "client_error") {
      await getPool().query(
        `
          insert into error_analytics (
            id, occurred_at, platform, source, severity, error_fingerprint, message_class,
            app_version, build_number, route_or_screen, account_user_hash, anonymous_id,
            session_id, properties
          )
          values ($1, $2, $3, 'client', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        `,
        [
          randomUUID(),
          parseOccurredAt(event.occurredAt).toISOString(),
          event.platform,
          event.properties.fatal === true ? "fatal" : "error",
          getErrorFingerprint(event),
          typeof event.properties.message === "string"
            ? event.properties.message.slice(0, 160)
            : null,
          event.appVersion ?? null,
          event.buildNumber ?? null,
          event.routeOrScreen ?? null,
          event.accountUserHash ?? null,
          event.anonymousId ?? null,
          event.sessionId ?? null,
          JSON.stringify(event.properties)
        ]
      );
    }
  }

  return accepted;
};

export const writeExtractionAnalyticsEvent = async (
  event: AnalyticsExtractionEventInput
): Promise<void> => {
  if (!enabled()) {
    return;
  }

  pushMemoryExtraction(event);

  if (!configured()) {
    return;
  }

  await ensureSchema();

  const extraction = event.extraction;

  await getPool().query(
    `
      insert into extraction_analytics (
        id, occurred_at, platform, anonymous_id, session_id, account_user_hash, correlation_id,
        app_version, build_number, source_hostname, source_type, status, attempt, strategy,
        fetch_mode, fallback_provider, confidence_score, latency_ms, billing_plan, blocked_reason,
        error_code, properties
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb)
    `,
    [
      randomUUID(),
      parseOccurredAt(event.occurredAt).toISOString(),
      event.platform,
      event.anonymousId ?? null,
      event.sessionId ?? null,
      event.accountUserHash ?? null,
      event.correlationId ?? null,
      event.appVersion ?? null,
      event.buildNumber ?? null,
      extraction?.hostname ?? null,
      extraction?.sourceType ?? "unknown",
      extraction?.outcomeStatus ?? "blocked",
      extraction?.attempt ?? "blocked",
      extraction?.strategy ?? "none",
      extraction?.fetchMode ?? "none",
      extraction?.fallbackProvider ?? "none",
      extraction?.confidenceScore ?? null,
      event.latencyMs,
      event.billingPlan,
      event.blockedReason ?? null,
      extraction?.failureReason ?? null,
      JSON.stringify({
        blockedSignalCount: extraction?.blockedSignals.length ?? 0,
        browserAttempted: extraction?.browserAttempted ?? false,
        meteringMode: event.meteringMode,
        missingFieldCount: extraction?.missingFieldCount ?? 0
      })
    ]
  );
};

const countBy = <Entry>(
  entries: Entry[],
  getKey: (entry: Entry) => string | null | undefined
): Record<string, number> => {
  const counts: Record<string, number> = {};

  for (const entry of entries) {
    const key = getKey(entry);

    if (!key) {
      continue;
    }

    counts[key] = (counts[key] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
};

const getSuccessRate = (statusCounts: Record<string, number>): number => {
  const total = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  return total === 0 ? 0 : Math.round(((statusCounts.success ?? 0) / total) * 1000) / 10;
};

const isFailedExtraction = (event: AnalyticsExtractionEventInput): boolean => {
  const status = event.extraction?.outcomeStatus ?? "blocked";
  return status === "failure" || status === "blocked";
};

const getFailureReason = (event: AnalyticsExtractionEventInput): string =>
  event.extraction?.failureReason ?? event.blockedReason ?? "unknown";

const createAnalyticsAlias = (
  prefix: "session" | "visitor",
  value: string | undefined
): string | null =>
  value ? `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}` : null;

const getMemoryFailureDrilldown = (): AnalyticsFailureDrilldown => {
  const failures = memoryExtractions.filter(isFailedExtraction);
  const visitorAliases = failures.map((event) =>
    createAnalyticsAlias("visitor", event.anonymousId ?? event.accountUserHash)
  );
  const sessionAliases = failures.map((event) => createAnalyticsAlias("session", event.sessionId));

  return {
    total: failures.length,
    distinctVisitors: new Set(visitorAliases.filter(Boolean)).size,
    distinctSessions: new Set(sessionAliases.filter(Boolean)).size,
    byReason: countBy(failures, getFailureReason),
    bySourceHostname: countBy(failures, (event) => event.extraction?.hostname ?? "unknown"),
    byPlatform: countBy(failures, (event) => event.platform),
    byBuild: countBy(
      failures,
      (event) =>
        [event.appVersion, event.buildNumber].filter(Boolean).join(" / ") || "unknown"
    ),
    byVisitor: countBy(visitorAliases, (alias) => alias),
    bySession: countBy(sessionAliases, (alias) => alias),
    recent: failures
      .slice()
      .reverse()
      .slice(0, 25)
      .map((event) => ({
        occurredAt: parseOccurredAt(event.occurredAt).toISOString(),
        reason: getFailureReason(event),
        sourceHostname: event.extraction?.hostname ?? null,
        platform: event.platform,
        appVersion: event.appVersion ?? null,
        buildNumber: event.buildNumber ?? null,
        visitorAlias: createAnalyticsAlias("visitor", event.anonymousId ?? event.accountUserHash),
        sessionAlias: createAnalyticsAlias("session", event.sessionId),
        correlationId: event.correlationId ?? null
      }))
  };
};

const getMemorySummary = (): AnalyticsDashboardSummary => {
  const extractionByStatus = countBy(
    memoryExtractions,
    (event) => event.extraction?.outcomeStatus ?? "blocked"
  );
  const sourceCounts = countBy(memoryExtractions, (event) => event.extraction?.hostname ?? null);

  return {
    configured: configured(),
    enabled: enabled(),
    source: enabled() ? "memory" : "disabled",
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    totals: {
      events: memoryEvents.length,
      uniqueVisitors: new Set(memoryEvents.map((event) => event.anonymousId).filter(Boolean)).size,
      extractionEvents: memoryExtractions.length,
      extractionSuccessRate: getSuccessRate(extractionByStatus),
      errors: memoryEvents.filter((event) => event.eventName === "client_error").length
    },
    byPlatform: countBy(memoryEvents, (event) => event.platform),
    byEventName: countBy(memoryEvents, (event) => event.eventName),
    extractionByStatus,
    topSourceHostnames: Object.entries(sourceCounts)
      .sort(([, left], [, right]) => right - left)
      .slice(0, 10)
      .map(([label, count]) => ({ label, count })),
    failureDrilldown: getMemoryFailureDrilldown(),
    notes: configured()
      ? ["Postgres analytics is configured, but this summary is using process memory."]
      : ["Set ANALYTICS_DATABASE_URL to persist analytics in Postgres."]
  };
};

const toNumber = (value: unknown): number =>
  typeof value === "number" ? value : typeof value === "string" ? Number(value) || 0 : 0;

const toNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const toIsoString = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
};

const rowsToRecord = (rows: Record<string, unknown>[]): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [String(row.label), toNumber(row.count)]));

export const getAnalyticsDashboardSummary = async (): Promise<AnalyticsDashboardSummary> => {
  if (!enabled() || !configured()) {
    return getMemorySummary();
  }

  try {
    await ensureSchema();

    const [
      eventTotals,
      platformRows,
      eventNameRows,
      extractionRows,
      sourceRows,
      failureTotals,
      failureReasonRows,
      failureSourceRows,
      failurePlatformRows,
      failureBuildRows,
      failureVisitorRows,
      failureSessionRows,
      recentFailureRows
    ] = await Promise.all([
      getPool().query(`
          select
            count(*)::int as events,
            count(distinct anonymous_id)::int as unique_visitors,
            count(*) filter (where event_name = 'client_error')::int as errors
          from analytics_events
          where occurred_at >= now() - interval '30 days'
        `),
      getPool().query(`
          select platform as label, count(*)::int as count
          from analytics_events
          where occurred_at >= now() - interval '30 days'
          group by platform
          order by platform
        `),
      getPool().query(`
          select event_name as label, count(*)::int as count
          from analytics_events
          where occurred_at >= now() - interval '30 days'
          group by event_name
          order by event_name
        `),
      getPool().query(`
          select status as label, count(*)::int as count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
          group by status
          order by status
        `),
      getPool().query(`
          select
            source_hostname as label,
            count(*)::int as count,
            count(*) filter (where status in ('failure', 'blocked'))::int as failure_count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days' and source_hostname is not null
          group by source_hostname
          order by count desc
          limit 10
        `),
      getPool().query(`
          select
            count(*)::int as total,
            count(distinct coalesce(anonymous_id::text, account_user_hash))::int
              as distinct_visitors,
            count(distinct session_id)::int as distinct_sessions
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
        `),
      getPool().query(`
          select coalesce(error_code, blocked_reason, 'unknown') as label, count(*)::int as count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
          group by label
          order by count desc, label
        `),
      getPool().query(`
          select coalesce(source_hostname, 'unknown') as label, count(*)::int as count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
          group by label
          order by count desc, label
        `),
      getPool().query(`
          select platform as label, count(*)::int as count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
          group by platform
          order by count desc, platform
        `),
      getPool().query(`
          select
            coalesce(nullif(concat_ws(' / ', app_version, build_number), ''), 'unknown') as label,
            count(*)::int as count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
          group by label
          order by count desc, label
        `),
      getPool().query(`
          select
            coalesce(
              'visitor-' || substr(md5(coalesce(anonymous_id::text, account_user_hash)), 1, 10),
              'unknown'
            ) as label,
            count(*)::int as count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
          group by label
          order by count desc, label
          limit 20
        `),
      getPool().query(`
          select
            coalesce('session-' || substr(md5(session_id::text), 1, 10), 'unknown') as label,
            count(*)::int as count
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
          group by label
          order by count desc, label
          limit 20
        `),
      getPool().query(`
          select
            occurred_at,
            coalesce(error_code, blocked_reason, 'unknown') as reason,
            source_hostname,
            platform,
            app_version,
            build_number,
            case
              when coalesce(anonymous_id::text, account_user_hash) is null then null
              else 'visitor-' ||
                substr(md5(coalesce(anonymous_id::text, account_user_hash)), 1, 10)
            end as visitor_alias,
            case
              when session_id is null then null
              else 'session-' || substr(md5(session_id::text), 1, 10)
            end as session_alias,
            correlation_id
          from extraction_analytics
          where occurred_at >= now() - interval '30 days'
            and status in ('failure', 'blocked')
          order by occurred_at desc
          limit 25
        `)
    ]);

    const extractionByStatus = rowsToRecord(extractionRows.rows);
    const totals = eventTotals.rows[0] ?? {};
    const extractionEvents = Object.values(extractionByStatus).reduce(
      (sum, count) => sum + count,
      0
    );
    const failureTotalsRow = failureTotals.rows[0] ?? {};

    return {
      configured: true,
      enabled: true,
      source: "postgres",
      generatedAt: new Date().toISOString(),
      windowDays: 30,
      totals: {
        events: toNumber(totals.events),
        uniqueVisitors: toNumber(totals.unique_visitors),
        extractionEvents,
        extractionSuccessRate: getSuccessRate(extractionByStatus),
        errors: toNumber(totals.errors)
      },
      byPlatform: rowsToRecord(platformRows.rows),
      byEventName: rowsToRecord(eventNameRows.rows),
      extractionByStatus,
      topSourceHostnames: sourceRows.rows.map((row) => ({
        label: String(row.label),
        count: toNumber(row.count),
        failureCount: toNumber(row.failure_count)
      })),
      failureDrilldown: {
        total: toNumber(failureTotalsRow.total),
        distinctVisitors: toNumber(failureTotalsRow.distinct_visitors),
        distinctSessions: toNumber(failureTotalsRow.distinct_sessions),
        byReason: rowsToRecord(failureReasonRows.rows),
        bySourceHostname: rowsToRecord(failureSourceRows.rows),
        byPlatform: rowsToRecord(failurePlatformRows.rows),
        byBuild: rowsToRecord(failureBuildRows.rows),
        byVisitor: rowsToRecord(failureVisitorRows.rows),
        bySession: rowsToRecord(failureSessionRows.rows),
        recent: recentFailureRows.rows.map((row) => ({
          occurredAt: toIsoString(row.occurred_at),
          reason: toNullableString(row.reason) ?? "unknown",
          sourceHostname: toNullableString(row.source_hostname),
          platform: toNullableString(row.platform) ?? "unknown",
          appVersion: toNullableString(row.app_version),
          buildNumber: toNullableString(row.build_number),
          visitorAlias: toNullableString(row.visitor_alias),
          sessionAlias: toNullableString(row.session_alias),
          correlationId: toNullableString(row.correlation_id)
        }))
      },
      notes: []
    };
  } catch (error) {
    return {
      ...getMemorySummary(),
      notes: [
        `Postgres analytics query failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        ...getMemorySummary().notes
      ]
    };
  }
};

export const closeAnalyticsStore = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
    schemaReady = false;
  }
};

export type { AnalyticsExtractionEventInput, AnalyticsWriteEvent };
