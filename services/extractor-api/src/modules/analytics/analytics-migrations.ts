import type { Pool } from "pg";

export interface AnalyticsMigration {
  version: number;
  name: string;
  sql: string;
}

/*
 * Versioned schema for the analytics database. Each migration runs once, in order, inside the
 * same transaction that records it in analytics_schema_migrations, so a failed migration leaves
 * nothing behind. Never edit a migration that has shipped: add a new one.
 *
 * Migration 1 is the schema the API used to create on every cold start. It keeps its
 * `if not exists` guards so databases created that way adopt it as their baseline.
 */
export const analyticsMigrations: readonly AnalyticsMigration[] = [
  {
    version: 1,
    name: "baseline",
    sql: `
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

    `
  },
  {
    version: 2,
    name: "retention_and_account_deletion_indexes",
    sql: `
      create index if not exists analytics_events_received_idx
        on analytics_events (received_at);
      create index if not exists extraction_analytics_received_idx
        on extraction_analytics (received_at);
      create index if not exists error_analytics_received_idx
        on error_analytics (received_at);
      create index if not exists external_store_metrics_date_idx
        on external_store_metrics (date);

      create index if not exists analytics_events_account_idx
        on analytics_events (account_user_hash)
        where account_user_hash is not null;
      create index if not exists extraction_analytics_account_idx
        on extraction_analytics (account_user_hash)
        where account_user_hash is not null;
      create index if not exists error_analytics_account_idx
        on error_analytics (account_user_hash)
        where account_user_hash is not null;
    `
  },
  {
    version: 3,
    name: "error_alerts",
    sql: `
      create index if not exists error_analytics_fingerprint_received_idx
        on error_analytics (error_fingerprint, received_at);

      create table if not exists error_alert_checkpoints (
        id smallint primary key,
        checked_until timestamptz not null
      );
    `
  }
];

const migrationsTable = "analytics_schema_migrations";

const readAppliedVersions = async (client: Pick<Pool, "query">): Promise<Set<number> | null> => {
  const exists = await client.query(
    `select to_regclass('${migrationsTable}') is not null as exists`
  );

  if (exists.rows[0]?.exists !== true) {
    return null;
  }

  const applied = await client.query(`select version from ${migrationsTable}`);
  return new Set(applied.rows.map((row) => Number(row.version)));
};

const getPendingMigrations = (
  applied: Set<number> | null,
  migrations: readonly AnalyticsMigration[]
): AnalyticsMigration[] => migrations.filter((migration) => !applied?.has(migration.version));

/**
 * Applies any pending analytics migrations and returns the versions it applied.
 *
 * The up-to-date case is two reads and no DDL. Otherwise the work runs in one transaction under
 * an advisory lock, so concurrent cold starts (or a CLI run during a deploy) apply each
 * migration once: whoever waits on the lock re-reads the applied versions after acquiring it.
 */
export const runAnalyticsMigrations = async (
  pool: Pool,
  migrations: readonly AnalyticsMigration[] = analyticsMigrations
): Promise<number[]> => {
  if (getPendingMigrations(await readAppliedVersions(pool), migrations).length === 0) {
    return [];
  }

  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('linkdish:analytics-migrations'))");
    await client.query(`
      create table if not exists ${migrationsTable} (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const pending = getPendingMigrations(await readAppliedVersions(client), migrations);

    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query(`insert into ${migrationsTable} (version, name) values ($1, $2)`, [
        migration.version,
        migration.name
      ]);
    }

    await client.query("commit");
    return pending.map((migration) => migration.version);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
