import { SPECIALISTS, opaqueIdSchema, type OpaqueId } from "@app/contracts";
import type { D1Database } from "@app/store-d1";
import { reserveModeledWrites } from "./write-budget.js";

export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const ACTIVE_REPORT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

interface RequestIdRow {
  readonly request_id: string;
}

interface CountRow {
  readonly count: number;
}

function failedCoverageSql(): string {
  return `json_object(${SPECIALISTS.flatMap((specialist) => [
    `'${specialist}'`,
    `CASE WHEN json_extract(coverage_json, '$.${specialist}') = 'waiting' THEN 'failed' ELSE json_extract(coverage_json, '$.${specialist}') END`,
  ]).join(",")})`;
}

async function count(
  database: D1Database,
  sql: string,
  requestId: OpaqueId,
): Promise<number> {
  const row = await database.prepare(sql).bind(requestId).first<CountRow>();
  return row?.count ?? 0;
}

/**
 * Fails one abandoned active request, invalidates all leases, and erases queued
 * recipient ciphertext. The 24-hour ceiling is deliberately much larger than
 * every network/scanner/lease timeout but finite under total worker loss.
 */
export async function expireStaleActiveReport(
  database: D1Database,
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs < ACTIVE_REPORT_TIMEOUT_MS) return;
  const cutoff = nowMs - ACTIVE_REPORT_TIMEOUT_MS;
  const candidate = await database
    .prepare(
      `SELECT request_id FROM scan_requests
       WHERE state IN ('accepted','discovering','scanning') AND updated_at_ms < ?
         AND NOT EXISTS (
           SELECT 1 FROM repositories
           WHERE repositories.request_id = scan_requests.request_id
             AND repositories.updated_at_ms >= ?
         )
       ORDER BY updated_at_ms, request_id LIMIT 1`,
    )
    .bind(cutoff, cutoff)
    .first<RequestIdRow>();
  if (candidate === null) return;
  const requestId = opaqueIdSchema.parse(candidate.request_id);
  const activeRepositories = await count(
    database,
    `SELECT COUNT(*) AS count FROM repositories
     WHERE request_id = ?
       AND state NOT IN ('complete','empty','partial','failed','cancelled')`,
    requestId,
  );
  const modeledWrites = 30 + activeRepositories * 10;
  if (!(await reserveModeledWrites(database, nowMs, modeledWrites))) return;

  await database.batch([
    database
      .prepare(
        `UPDATE scan_requests
         SET state = 'failed', reason = 'CANCELLED', updated_at_ms = ?
         WHERE request_id = ?
           AND state IN ('accepted','discovering','scanning') AND updated_at_ms < ?
           AND NOT EXISTS (
             SELECT 1 FROM repositories
             WHERE repositories.request_id = scan_requests.request_id
               AND repositories.updated_at_ms >= ?
           )`,
      )
      .bind(nowMs, requestId, cutoff, cutoff),
    database
      .prepare(
        `UPDATE repositories SET state = 'failed', reason = 'CANCELLED',
           specialist_reasons = '{}', coverage_json = ${failedCoverageSql()},
           lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
         WHERE request_id = ?
           AND state NOT IN ('complete','empty','partial','failed','cancelled')
           AND EXISTS (
             SELECT 1 FROM scan_requests
             WHERE request_id = ? AND state = 'failed' AND reason = 'CANCELLED'
               AND updated_at_ms = ?
           )`,
      )
      .bind(nowMs, requestId, requestId, nowMs),
    database
      .prepare(
        `UPDATE scan_notifications
         SET state = 'failed', claimed_at_ms = NULL, updated_at_ms = ?,
             recipient_ciphertext = '', recipient_iv = ''
         WHERE request_id = ? AND state IN ('pending','sending')
           AND EXISTS (
             SELECT 1 FROM scan_requests
             WHERE request_id = ? AND state = 'failed' AND reason = 'CANCELLED'
               AND updated_at_ms = ?
           )`,
      )
      .bind(nowMs, requestId, requestId, nowMs),
  ]);
}

/** Deletes at most one terminal report after conservatively reserving its cascade. */
export async function purgeExpiredReports(
  database: D1Database,
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs < REPORT_RETENTION_MS) return;
  const cutoff = nowMs - REPORT_RETENTION_MS;
  const candidate = await database
    .prepare(
      `SELECT request_id FROM scan_requests
       WHERE state IN ('complete','failed') AND updated_at_ms < ?
       ORDER BY updated_at_ms, request_id LIMIT 1`,
    )
    .bind(cutoff)
    .first<RequestIdRow>();
  if (candidate === null) return;
  const requestId = opaqueIdSchema.parse(candidate.request_id);
  const [repositories, findingChunks, reservations, notifications] = await Promise.all([
    count(
      database,
      "SELECT COUNT(*) AS count FROM repositories WHERE request_id = ?",
      requestId,
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM finding_chunks WHERE request_id = ?",
      requestId,
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM write_reservations WHERE request_id = ?",
      requestId,
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM scan_notifications WHERE request_id = ?",
      requestId,
    ),
  ]);
  const rows = 2 + repositories + findingChunks + reservations + notifications;
  const modeledWrites = 10 + rows * 4;
  if (!(await reserveModeledWrites(database, nowMs, modeledWrites))) return;
  await database
    .prepare(
      `DELETE FROM scan_requests
       WHERE request_id = ? AND state IN ('complete','failed') AND updated_at_ms < ?`,
    )
    .bind(requestId, cutoff)
    .run();
}
