import type { D1Database } from "@app/store-d1";

export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH_SIZE = 25;

/**
 * Deletes only terminal reports, in a bounded batch. Foreign-key cascades
 * remove their ledgers, findings, reservations, and notification metadata.
 */
export async function purgeExpiredReports(
  database: D1Database,
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs < REPORT_RETENTION_MS) return;
  await database
    .prepare(
      `DELETE FROM scan_requests
       WHERE request_id IN (
         SELECT request_id
         FROM scan_requests
         WHERE state IN ('complete','failed') AND updated_at_ms < ?
         ORDER BY updated_at_ms ASC, request_id ASC
         LIMIT ?
       )`,
    )
    .bind(nowMs - REPORT_RETENTION_MS, PURGE_BATCH_SIZE)
    .run();
}
