import type { D1Database } from "@app/store-d1";

/** Maintenance may use 60% of D1 Free; scan admission stops at 40% in SQL. */
export const MODELED_DAILY_WRITE_LIMIT = 60_000;

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Conservatively reserves maintenance work before any corresponding mutation. */
export async function reserveModeledWrites(
  database: D1Database,
  nowMs: number,
  modeledWrites: number,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(modeledWrites) ||
    modeledWrites < 1 ||
    modeledWrites > MODELED_DAILY_WRITE_LIMIT
  ) {
    return false;
  }
  const day = utcDay(nowMs);
  await database
    .prepare(
      `INSERT INTO write_budget(utc_day, modeled_writes)
       VALUES (?, 0) ON CONFLICT(utc_day) DO NOTHING`,
    )
    .bind(day)
    .run();
  const reserved = await database
    .prepare(
      `UPDATE write_budget SET modeled_writes = modeled_writes + ?
       WHERE utc_day = ? AND modeled_writes + ? <= ?
       RETURNING 1 AS reserved`,
    )
    .bind(modeledWrites, day, modeledWrites, MODELED_DAILY_WRITE_LIMIT)
    .first<{ reserved: number }>();
  return reserved?.reserved === 1;
}
