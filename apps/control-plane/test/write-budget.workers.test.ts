import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MODELED_DAILY_WRITE_LIMIT,
  reserveModeledWrites,
} from "../src/write-budget.js";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM write_budget;");
});

describe("modeled D1 write headroom", () => {
  it("reserves exactly the 60% ceiling and fails closed above it", async () => {
    expect(await reserveModeledWrites(env.DB, 0, MODELED_DAILY_WRITE_LIMIT - 1)).toBe(
      true,
    );
    expect(await reserveModeledWrites(env.DB, 0, 1)).toBe(true);
    expect(await reserveModeledWrites(env.DB, 0, 1)).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT modeled_writes FROM write_budget WHERE utc_day = '1970-01-01'",
      ).first<number>("modeled_writes"),
    ).toBe(MODELED_DAILY_WRITE_LIMIT);
  });

  it("rejects invalid reservations without creating a budget row", async () => {
    expect(await reserveModeledWrites(env.DB, -1, 1)).toBe(false);
    expect(await reserveModeledWrites(env.DB, 0, 0)).toBe(false);
    expect(await reserveModeledWrites(env.DB, 0, MODELED_DAILY_WRITE_LIMIT + 1)).toBe(
      false,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM write_budget").first<number>(
        "count",
      ),
    ).toBe(0);
  });
});
