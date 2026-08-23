import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPECIALISTS, SPECIALIST_PROGRESS_STATES } from "@app/contracts";

/**
 * The D1 trigger that keeps per-request coverage totals in step is written out
 * by hand, one arm per specialist per state, while the SQLite store generates
 * the same trigger from `SPECIALISTS`. So adding a fifth scan engine updated
 * one and not the other, and a finished twenty-three repository request told
 * the public API that all twenty-three AI checks were still waiting.
 *
 * This reads the migrations as text, because that is what actually ships.
 */

const MIGRATIONS = path.join(
  fileURLToPath(new URL("../", import.meta.url)),
  "migrations",
);

/** The trigger as it stands after every migration has been applied in order. */
function currentTrigger(): string {
  let trigger = "";
  for (const name of readdirSync(MIGRATIONS).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS, name), "utf8");
    const start = sql.indexOf(
      "CREATE TRIGGER request_totals_after_repository_update",
    );
    if (start === -1) continue;
    const end = sql.indexOf("\nEND", start);
    trigger = sql.slice(start, end === -1 ? undefined : end);
  }
  return trigger;
}

describe("the request totals trigger", () => {
  it("exists, so this guard cannot pass vacuously", () => {
    expect(currentTrigger().length).toBeGreaterThan(1_000);
  });

  it("counts every specialist in every state", () => {
    const trigger = currentTrigger();
    const missing: string[] = [];
    for (const specialist of SPECIALISTS) {
      for (const state of SPECIALIST_PROGRESS_STATES) {
        if (!trigger.includes(`'$.${specialist}.${state}'`)) {
          missing.push(`${specialist}.${state}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("starts every request with a bucket for every specialist", () => {
    // The default on request_totals is a literal JSON object, so a specialist
    // absent from it has nowhere for the trigger to add to.
    const initial = readFileSync(
      path.join(MIGRATIONS, "0001_initial.sql"),
      "utf8",
    );
    const backfilled = readdirSync(MIGRATIONS)
      .sort()
      .map((name) => readFileSync(path.join(MIGRATIONS, name), "utf8"))
      .join("\n");
    for (const specialist of SPECIALISTS) {
      const known =
        initial.includes(`"${specialist}":`) ||
        backfilled.includes(`'$.${specialist}.waiting'`);
      expect(known, `${specialist} has no starting bucket`).toBe(true);
    }
  });
});
