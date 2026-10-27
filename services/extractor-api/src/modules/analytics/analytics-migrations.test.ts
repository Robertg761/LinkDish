import { describe, expect, it, vi } from "vitest";

import { analyticsMigrations, runAnalyticsMigrations } from "./analytics-migrations.js";

import type { AnalyticsMigration } from "./analytics-migrations.js";
import type { Pool } from "pg";

const testMigrations: AnalyticsMigration[] = [
  { version: 1, name: "first", sql: "-- first" },
  { version: 2, name: "second", sql: "-- second" }
];

/*
 * A stand-in for pg: it answers the runner's two reads from `appliedVersions` and records every
 * statement, on the pool and on the checked-out client, in one list.
 */
const createFakePool = (options: { appliedVersions: number[] | null; failOn?: string }) => {
  const statements: string[] = [];
  const release = vi.fn();
  const query = vi.fn((text: string, params?: unknown[]) => {
    const statement = text.replace(/\s+/gu, " ").trim();
    statements.push(params ? `${statement} ${JSON.stringify(params)}` : statement);

    if (options.failOn && statement.includes(options.failOn)) {
      return Promise.reject(new Error(`failed: ${options.failOn}`));
    }

    if (statement.startsWith("select to_regclass")) {
      return Promise.resolve({ rowCount: 1, rows: [{ exists: options.appliedVersions !== null }] });
    }

    if (statement.startsWith("select version from")) {
      return Promise.resolve({
        rowCount: options.appliedVersions?.length ?? 0,
        rows: (options.appliedVersions ?? []).map((version) => ({ version }))
      });
    }

    return Promise.resolve({ rowCount: 0, rows: [] });
  });
  const connect = vi.fn(() => Promise.resolve({ query, release }));
  const pool = {
    connect,
    end: vi.fn(),
    query
  } as unknown as Pool;

  return { connect, pool, release, statements };
};

describe("runAnalyticsMigrations", () => {
  it("numbers the shipped migrations 1, 2, 3... with no gaps", () => {
    expect(analyticsMigrations.map((migration) => migration.version)).toEqual(
      analyticsMigrations.map((_, index) => index + 1)
    );
  });

  it("does nothing but read when the database is current", async () => {
    const { connect, pool, statements } = createFakePool({ appliedVersions: [1, 2] });

    await expect(runAnalyticsMigrations(pool, testMigrations)).resolves.toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.startsWith("select"))).toBe(true);
  });

  it("applies every migration to a database that has none, under the lock, in one transaction", async () => {
    const { pool, release, statements } = createFakePool({ appliedVersions: null });

    await expect(runAnalyticsMigrations(pool, testMigrations)).resolves.toEqual([1, 2]);
    expect(statements.slice(1)).toEqual([
      "begin",
      "select pg_advisory_xact_lock(hashtext('linkdish:analytics-migrations'))",
      expect.stringContaining("create table if not exists analytics_schema_migrations"),
      "select to_regclass('analytics_schema_migrations') is not null as exists",
      "-- first",
      'insert into analytics_schema_migrations (version, name) values ($1, $2) [1,"first"]',
      "-- second",
      'insert into analytics_schema_migrations (version, name) values ($1, $2) [2,"second"]',
      "commit"
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("applies only the migrations a database is missing", async () => {
    const { pool, statements } = createFakePool({ appliedVersions: [1] });

    await expect(runAnalyticsMigrations(pool, testMigrations)).resolves.toEqual([2]);
    expect(statements).not.toContain("-- first");
    expect(statements).toContain("-- second");
  });

  it("rolls back and releases the connection when a migration fails", async () => {
    const { pool, release, statements } = createFakePool({
      appliedVersions: null,
      failOn: "-- second"
    });

    await expect(runAnalyticsMigrations(pool, testMigrations)).rejects.toThrow("failed: -- second");
    expect(statements.at(-1)).toBe("rollback");
    expect(statements).not.toContain("commit");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
