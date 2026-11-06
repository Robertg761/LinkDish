import type { RecipeArchiveRecord, RecipeArchiveStore } from "./recipe-archive.js";

/*
 * The recipe archive in the Postgres database the API already uses for analytics (table
 * recipe_archive, analytics migration 4). The pool and migrations are loaded on first use, so
 * a cold /extract does not pay for the pg driver unless it looks a link up.
 */

/** The slice of pg's Pool the store uses. */
export interface RecipeArchiveDatabase {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

interface RecipeArchiveRow {
  url_hash: string;
  canonical_url: string;
  source_hostname: string;
  source_type: string;
  extractor_version: string;
  origin: string;
  response: unknown;
  final_url: string | null;
  status_code: number | null;
  detection_confidence: string;
  extracted_at: Date | string;
  refresh_failed_at: Date | string | null;
}

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toRecord = (row: RecipeArchiveRow): RecipeArchiveRecord => ({
  urlHash: row.url_hash,
  canonicalUrl: row.canonical_url,
  sourceHostname: row.source_hostname,
  sourceType: row.source_type,
  extractorVersion: row.extractor_version,
  origin: "server",
  response: row.response,
  finalUrl: row.final_url,
  statusCode: row.status_code,
  detectionConfidence: row.detection_confidence as RecipeArchiveRecord["detectionConfidence"],
  extractedAt: toIso(row.extracted_at),
  refreshFailedAt: row.refresh_failed_at ? toIso(row.refresh_failed_at) : null
});

export const createPostgresRecipeArchiveStore = (
  getPool: () => Promise<RecipeArchiveDatabase | null>
): RecipeArchiveStore => {
  const requirePool = async (): Promise<RecipeArchiveDatabase> => {
    const pool = await getPool();

    if (!pool) {
      throw new Error("The recipe archive database is not configured.");
    }

    return pool;
  };

  return {
    get: async (urlHash) => {
      const pool = await requirePool();
      const result = await pool.query(
        `select url_hash, canonical_url, source_hostname, source_type, extractor_version, origin,
                response, final_url, status_code, detection_confidence, extracted_at,
                refresh_failed_at
           from recipe_archive
          where url_hash = $1`,
        [urlHash]
      );
      const row = result.rows[0] as RecipeArchiveRow | undefined;
      return row ? toRecord(row) : null;
    },
    put: async (record) => {
      const pool = await requirePool();
      /* A link an admin removed (recipe_archive_removals) is never stored again. */
      const result = await pool.query(
        `insert into recipe_archive (
           url_hash, canonical_url, source_hostname, source_type, extractor_version, origin,
           response, final_url, status_code, detection_confidence, extracted_at
         )
         select $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::jsonb, $8::text,
                $9::integer, $10::text, $11::timestamptz
          where not exists (select 1 from recipe_archive_removals where url_hash = $1::text)
         on conflict (url_hash) do update set
           canonical_url = excluded.canonical_url,
           source_hostname = excluded.source_hostname,
           source_type = excluded.source_type,
           extractor_version = excluded.extractor_version,
           origin = excluded.origin,
           response = excluded.response,
           final_url = excluded.final_url,
           status_code = excluded.status_code,
           detection_confidence = excluded.detection_confidence,
           extracted_at = excluded.extracted_at,
           refresh_failed_at = null`,
        [
          record.urlHash,
          record.canonicalUrl,
          record.sourceHostname,
          record.sourceType,
          record.extractorVersion,
          record.origin,
          JSON.stringify(record.response),
          record.finalUrl,
          record.statusCode,
          record.detectionConfidence,
          record.extractedAt
        ]
      );
      return (result.rowCount ?? 0) > 0;
    },
    markRefreshFailed: async (urlHash, at) => {
      const pool = await requirePool();
      await pool.query(`update recipe_archive set refresh_failed_at = $2 where url_hash = $1`, [
        urlHash,
        at
      ]);
    },
    remove: async (urlHash, canonicalUrl, at) => {
      const pool = await requirePool();
      const result = await pool.query(
        `with removed as (
           delete from recipe_archive where url_hash = $1 returning 1
         ), marked as (
           insert into recipe_archive_removals (url_hash, canonical_url, removed_at)
           values ($1, $2, $3)
           on conflict (url_hash) do update set removed_at = excluded.removed_at
         )
         select count(*)::integer as removed from removed`,
        [urlHash, canonicalUrl, at]
      );
      return Number(result.rows[0]?.removed ?? 0) > 0;
    }
  };
};
