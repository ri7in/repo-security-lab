import { env } from "cloudflare:workers";
import { D1Store } from "@app/store-d1";
import { describe, it } from "vitest";
import {
  readDeepReadBudget,
  recordModeledDeepRead,
} from "../src/deep-read-budget.js";

// Its own file: the shared D1 state is per-file, and this test dirties the
// spend table for a fixed day.

describe("the deep-read meter", () => {
  it("moves by exactly one when one repository's deep read is charged", async ({ expect }) => {
    void new D1Store(env.DB);
    const nowMs = Date.UTC(2026, 7, 25, 12, 0, 0);
    const before = await readDeepReadBudget(env.DB, nowMs, 2);
    expect(before.deepReadsRemaining).toBe(before.deepReadsPerDay);

    await recordModeledDeepRead(env.DB, nowMs);
    const afterOne = await readDeepReadBudget(env.DB, nowMs, 2);
    expect(afterOne.deepReadsPerDay).toBe(before.deepReadsPerDay);
    expect(afterOne.deepReadsRemaining).toBe(before.deepReadsRemaining - 1);

    await recordModeledDeepRead(env.DB, nowMs);
    await recordModeledDeepRead(env.DB, nowMs);
    const afterThree = await readDeepReadBudget(env.DB, nowMs, 2);
    expect(afterThree.deepReadsRemaining).toBe(before.deepReadsRemaining - 3);

    // A different day is a fresh meter.
    const nextDay = await readDeepReadBudget(
      env.DB,
      nowMs + 24 * 60 * 60 * 1_000,
      2,
    );
    expect(nextDay.deepReadsRemaining).toBe(nextDay.deepReadsPerDay);
  });
});
