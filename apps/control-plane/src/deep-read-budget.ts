import {
  COUNCIL,
  MODELED_REQUESTS_PER_REPO,
  MODELED_TOKENS_PER_REPO,
  councilBudget,
  toDeepReadBudget,
  type ModelSpend,
} from "@app/quota";
import type { DeepReadBudget } from "@app/contracts";
import type { D1Database } from "@app/store-d1";

/**
 * Reads today's council spend and reports the remaining allowance.
 *
 * Failure is deliberately optimistic about the ledger and pessimistic about
 * nothing: an unreadable spend table reports the untouched-day budget rather
 * than zero, because a database hiccup must not tell every visitor the lane is
 * exhausted. The lane's real gate is the reservation performed before a model
 * call, not this read-only display value.
 */
export async function readDeepReadBudget(
  database: D1Database,
  nowMs: number,
  readerKeyPoolSize = 1,
): Promise<DeepReadBudget> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const spend = new Map<string, ModelSpend>();
  try {
    const rows = await database
      .prepare(
        `SELECT model_id, spent_tokens, spent_requests
         FROM deep_read_spend WHERE utc_day = ?`,
      )
      .bind(day)
      .all<{
        model_id: string;
        spent_tokens: number;
        spent_requests: number;
      }>();
    for (const row of rows.results ?? []) {
      spend.set(row.model_id, {
        tokens: row.spent_tokens,
        requests: row.spent_requests,
      });
    }
  } catch {
    return toDeepReadBudget(councilBudget(new Map(), undefined, readerKeyPoolSize));
  }
  return toDeepReadBudget(councilBudget(spend, undefined, readerKeyPoolSize));
}

/**
 * Records spend after a model call returns.
 *
 * Counters only move forward. The caller reserves before calling a provider and
 * records afterwards, so a crash between the two overstates usage rather than
 * understating it, which is the safe direction for a free allowance.
 */
export async function recordDeepReadSpend(
  database: D1Database,
  nowMs: number,
  modelId: string,
  used: ModelSpend,
): Promise<void> {
  if (!COUNCIL.some((model) => model.id === modelId)) return;
  const tokens = Math.max(0, Math.trunc(used.tokens));
  const requests = Math.max(0, Math.trunc(used.requests));
  if (tokens === 0 && requests === 0) return;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  await database
    .prepare(
      `INSERT INTO deep_read_spend(utc_day, model_id, spent_tokens, spent_requests)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(utc_day, model_id) DO UPDATE SET
         spent_tokens = spent_tokens + excluded.spent_tokens,
         spent_requests = spent_requests + excluded.spent_requests`,
    )
    .bind(day, modelId, tokens, requests)
    .run();
}

/**
 * Charges one repository's deep read to today's budget, at modeled cost.
 *
 * The worker does not report what each provider call actually cost, and the
 * displayed budget is computed from the same modeled per-repository costs used
 * here, so charging the model keeps the meter and the maths in one currency:
 * one deep-read repository moves the display by exactly one. Until this was
 * called, the meter read whatever the untouched day was worth, every day; the
 * front page had to describe its own number as "a stated ceiling, not a live
 * countdown", which for a product about honest reporting was an embarrassing
 * sentence to need.
 */
export async function recordModeledDeepRead(
  database: D1Database,
  nowMs: number,
): Promise<void> {
  for (const model of COUNCIL) {
    await recordDeepReadSpend(database, nowMs, model.id, {
      tokens: MODELED_TOKENS_PER_REPO[model.role],
      requests: MODELED_REQUESTS_PER_REPO[model.role],
    });
  }
}
