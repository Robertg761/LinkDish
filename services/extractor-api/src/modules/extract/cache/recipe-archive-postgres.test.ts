import { describe, expect, it, vi } from "vitest";

import {
  createPostgresRecipeArchiveStore,
  type RecipeArchiveDatabase
} from "./recipe-archive-postgres";

const record = {
  urlHash: "abc",
  canonicalUrl: "https://example.com/recipe",
  sourceHostname: "example.com",
  sourceType: "recipe_site",
  extractorVersion: "2026-10-29.1",
  origin: "server" as const,
  response: { status: "success" },
  finalUrl: "https://example.com/recipe",
  statusCode: 200,
  detectionConfidence: "high" as const,
  extractedAt: "2026-11-06T00:00:00.000Z"
};

const createDatabase = (rows: Record<string, unknown>[] = [], rowCount = 0) => {
  const query = vi.fn<RecipeArchiveDatabase["query"]>(() => Promise.resolve({ rows, rowCount }));
  return { query };
};

describe("postgres recipe archive store", () => {
  it("upserts an entry and clears a failed refresh", async () => {
    const database = createDatabase();
    const store = createPostgresRecipeArchiveStore(() => Promise.resolve(database));

    await store.put(record);

    const [sql, values] = database.query.mock.calls[0] ?? [];
    expect(sql).toContain("on conflict (url_hash) do update");
    expect(sql).toContain("refresh_failed_at = null");
    expect(values).toEqual([
      "abc",
      "https://example.com/recipe",
      "example.com",
      "recipe_site",
      "2026-10-29.1",
      "server",
      JSON.stringify({ status: "success" }),
      "https://example.com/recipe",
      200,
      "high",
      "2026-11-06T00:00:00.000Z"
    ]);
  });

  it("reads a row back as a record", async () => {
    const database = createDatabase([
      {
        url_hash: "abc",
        canonical_url: "https://example.com/recipe",
        source_hostname: "example.com",
        source_type: "recipe_site",
        extractor_version: "2026-10-29.1",
        origin: "server",
        response: { status: "success" },
        final_url: null,
        status_code: null,
        detection_confidence: "medium",
        extracted_at: new Date("2026-11-06T00:00:00.000Z"),
        refresh_failed_at: "2026-11-07T00:00:00.000Z"
      }
    ]);
    const store = createPostgresRecipeArchiveStore(() => Promise.resolve(database));

    await expect(store.get("abc")).resolves.toEqual({
      ...record,
      finalUrl: null,
      statusCode: null,
      detectionConfidence: "medium",
      refreshFailedAt: "2026-11-07T00:00:00.000Z"
    });
    expect(database.query.mock.calls[0]?.[1]).toEqual(["abc"]);
  });

  it("returns null for a missing row", async () => {
    const empty = createPostgresRecipeArchiveStore(() => Promise.resolve(createDatabase()));

    await expect(empty.get("missing")).resolves.toBeNull();
  });

  it("reports whether a put stored anything (a removed link stores nothing)", async () => {
    const stored = createDatabase([], 1);
    const blocked = createDatabase([], 0);

    await expect(
      createPostgresRecipeArchiveStore(() => Promise.resolve(stored)).put(record)
    ).resolves.toBe(true);
    await expect(
      createPostgresRecipeArchiveStore(() => Promise.resolve(blocked)).put(record)
    ).resolves.toBe(false);
    expect(stored.query.mock.calls[0]?.[0]).toContain(
      "where not exists (select 1 from recipe_archive_removals"
    );
  });

  it("removes an entry and records the removal", async () => {
    const existed = createDatabase([{ removed: 1 }]);
    const missing = createDatabase([{ removed: 0 }]);

    await expect(
      createPostgresRecipeArchiveStore(() => Promise.resolve(existed)).remove(
        "abc",
        "https://example.com/recipe",
        "2026-11-07T00:00:00.000Z"
      )
    ).resolves.toBe(true);
    await expect(
      createPostgresRecipeArchiveStore(() => Promise.resolve(missing)).remove(
        "abc",
        "https://example.com/recipe",
        "2026-11-07T00:00:00.000Z"
      )
    ).resolves.toBe(false);
    expect(existed.query.mock.calls[0]?.[0]).toContain("insert into recipe_archive_removals");
    expect(existed.query.mock.calls[0]?.[1]).toEqual([
      "abc",
      "https://example.com/recipe",
      "2026-11-07T00:00:00.000Z"
    ]);
  });

  it("fails clearly without a database", async () => {
    const store = createPostgresRecipeArchiveStore(() => Promise.resolve(null));

    await expect(store.get("abc")).rejects.toThrow("not configured");
  });
});
