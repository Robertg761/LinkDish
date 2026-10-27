import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queries, rowsToDelete } = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; params: unknown[] | undefined }>,
  rowsToDelete: new Map<string, number>()
}));

/* A Postgres stand-in whose database is already migrated and holds `rowsToDelete` per table. */
vi.mock("pg", () => ({
  Pool: class {
    public query(text: string, params?: unknown[]) {
      const statement = text.replace(/\s+/gu, " ").trim();
      queries.push({ text: statement, params });

      if (statement.startsWith("select to_regclass")) {
        return Promise.resolve({ rowCount: 1, rows: [{ exists: true }] });
      }

      if (statement.startsWith("select version from")) {
        return Promise.resolve({ rowCount: 2, rows: [{ version: 1 }, { version: 2 }] });
      }

      const table = /^delete from (\w+)/u.exec(statement)?.[1];

      if (!table) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      const remaining = rowsToDelete.get(table) ?? 0;
      const limit = typeof params?.[1] === "number" ? params[1] : remaining;
      const deleted = Math.min(remaining, limit);
      rowsToDelete.set(table, remaining - deleted);

      return Promise.resolve({ rowCount: deleted, rows: [] });
    }

    public end() {
      return Promise.resolve();
    }
  }
}));

beforeEach(() => {
  vi.resetModules();
  queries.length = 0;
  rowsToDelete.clear();
  vi.stubEnv("ANALYTICS_DATABASE_URL", "postgres://postgres@localhost:5432/analytics");
  vi.stubEnv("ANALYTICS_ENABLED", "false");
  vi.stubEnv("ANALYTICS_RETENTION_DAYS", "180");
  vi.stubEnv("ANALYTICS_ROLLUP_RETENTION_DAYS", "1095");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const now = new Date("2026-10-26T12:00:00.000Z");

describe("purgeExpiredAnalytics", () => {
  it("deletes expired raw rows in batches by received time, and old rollups", async () => {
    const { purgeExpiredAnalytics } = await import("./analytics-store.js");
    rowsToDelete.set("analytics_events", 5);
    rowsToDelete.set("error_analytics", 1);
    rowsToDelete.set("daily_analytics_rollups", 3);

    await expect(purgeExpiredAnalytics({ batchSize: 2, now })).resolves.toEqual({
      complete: true,
      configured: true,
      deleted: {
        analyticsEvents: 5,
        dailyAnalyticsRollups: 3,
        errorAnalytics: 1,
        externalStoreMetrics: 0,
        extractionAnalytics: 0
      },
      rawCutoff: "2026-04-29T12:00:00.000Z",
      rollupCutoff: "2023-10-27"
    });

    const deletes = queries.filter((query) => query.text.startsWith("delete"));
    expect(
      deletes.filter((query) => query.text.startsWith("delete from analytics_events"))
    ).toHaveLength(3);
    expect(deletes.slice(0, 2)).toEqual([
      {
        params: ["2023-10-27"],
        text: "delete from daily_analytics_rollups where date < $1::date"
      },
      {
        params: ["2023-10-27"],
        text: "delete from external_store_metrics where date < $1::date"
      }
    ]);
    expect(deletes[2]?.params).toEqual(["2026-04-29T12:00:00.000Z", 2]);
    expect(deletes[2]?.text).toContain("where received_at < $1");
  });

  it("keeps everything when no retention is set", async () => {
    vi.stubEnv("ANALYTICS_RETENTION_DAYS", "");
    vi.stubEnv("ANALYTICS_ROLLUP_RETENTION_DAYS", "");
    const { purgeExpiredAnalytics } = await import("./analytics-store.js");
    rowsToDelete.set("analytics_events", 5);
    rowsToDelete.set("daily_analytics_rollups", 3);

    await expect(purgeExpiredAnalytics({ now })).resolves.toMatchObject({
      complete: true,
      configured: true,
      rawCutoff: null,
      rollupCutoff: null
    });
    expect(queries).toEqual([]);
  });

  it("purges only the table group whose retention is set", async () => {
    vi.stubEnv("ANALYTICS_RETENTION_DAYS", "");
    const { purgeExpiredAnalytics } = await import("./analytics-store.js");
    rowsToDelete.set("analytics_events", 5);
    rowsToDelete.set("daily_analytics_rollups", 3);

    await expect(purgeExpiredAnalytics({ now })).resolves.toMatchObject({
      deleted: { analyticsEvents: 0, dailyAnalyticsRollups: 3 },
      rawCutoff: null,
      rollupCutoff: "2023-10-27"
    });
    expect(rowsToDelete.get("analytics_events")).toBe(5);
  });

  it("purges rollups, then stops raw batches at the time budget and reports the run as incomplete", async () => {
    const { purgeExpiredAnalytics } = await import("./analytics-store.js");
    rowsToDelete.set("analytics_events", 10);
    rowsToDelete.set("daily_analytics_rollups", 3);

    const result = await purgeExpiredAnalytics({ batchSize: 2, now, timeBudgetMs: -1 });

    expect(result.complete).toBe(false);
    expect(result.deleted.analyticsEvents).toBe(0);
    expect(result.deleted.dailyAnalyticsRollups).toBe(3);
    expect(rowsToDelete.get("analytics_events")).toBe(10);
  });
});

describe("deleteAnalyticsForAccount", () => {
  it("deletes the account's rows from every raw table even with analytics switched off", async () => {
    const { deleteAnalyticsForAccount } = await import("./analytics-store.js");
    const { hashAnalyticsUserId } = await import("./analytics-privacy.js");
    rowsToDelete.set("analytics_events", 4);
    rowsToDelete.set("extraction_analytics", 2);

    await expect(deleteAnalyticsForAccount("user_1")).resolves.toEqual({
      analyticsEvents: 4,
      errorAnalytics: 0,
      extractionAnalytics: 2
    });
    expect(queries.filter((query) => query.text.startsWith("delete"))).toEqual(
      ["analytics_events", "extraction_analytics", "error_analytics"].map((table) => ({
        params: [hashAnalyticsUserId("user_1")],
        text: `delete from ${table} where account_user_hash = $1`
      }))
    );
  });
});
