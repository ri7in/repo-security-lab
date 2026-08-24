import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COUNCIL, GEMINI_FLASH_LITE, isVerified } from "../src/index.js";

/**
 * The budget and the worker have to be talking about the same models.
 *
 * They drifted once and nobody noticed: the landing page kept reporting a
 * daily allowance derived from a reader OpenRouter had already removed and a
 * judge the worker never called. The number looked plausible, which is exactly
 * why it survived. This reads the worker's own configuration and refuses any
 * model id that is neither budgeted nor deliberately excluded here with a
 * reason.
 */

const CONFIG = path.join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "apps/scan-worker/src/runtime-config.ts",
);

/**
 * Model ids the worker may name without a budget entry, each with its reason.
 *
 * An entry here is a promise that the model cannot make the reported allowance
 * wrong: either something else is the binding constraint, or a budgeted model
 * carries the same work the moment this one is unavailable.
 */
const EXCLUDED: ReadonlyMap<string, string> = new Map([
  [
    "stealth/ox-alpha",
    "An unbranded preview with no published limit. It is the preferred reader, " +
      "and the budgeted fallback takes over the moment it disappears, so the " +
      "reported allowance is the conservative one either way.",
  ],
  [
    GEMINI_FLASH_LITE.id,
    "Google no longer publishes a per-model free-tier table, so any number " +
      "would be invented. Understating scarcity here is the accepted cost.",
  ],
  [
    "z-ai/glm-5.2:free",
    "Third link of the reader chain. OpenRouter's free tier meters requests " +
      "account-wide across every :free model, and the budgeted nemotron " +
      "entry already counts that one shared meter. A second entry on the " +
      "same meter would double-count it; this link adds availability, " +
      "never allowance.",
  ],
  [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "Fourth link of the reader chain, on the same shared account-wide " +
      "OpenRouter meter as the entry above. Same reasoning.",
  ],
  [
    "qwen/qwen3.6-27b",
    "Fourth judge, last in trust, consulted only when a senior judge is " +
      "unreachable, so it never moves the scarcest-member arithmetic. Groq " +
      "publishes a row for it (30 RPM, 1K RPD, 8K TPM, 200K TPD, verified " +
      "2026-08-24) but is ambiguous about whether that meter is shared with " +
      "the budgeted gpt-oss judge on one organisation; a shared meter " +
      "budgeted twice would overstate the allowance, and this file does " +
      "not guess.",
  ],
]);

function modelIdsNamedByTheWorker(): readonly string[] {
  const source = readFileSync(CONFIG, "utf8");
  // Only string literals inside the model configuration, not env var names.
  return [...source.matchAll(/"([a-z0-9][a-z0-9._/-]*(?:\/|-latest)[a-z0-9.:_-]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.includes("/") || value.endsWith("-latest"))
    .filter((value) => !value.includes("://"));
}

describe("the council the worker actually runs", () => {
  it("names at least one model, so this guard cannot pass vacuously", () => {
    expect(modelIdsNamedByTheWorker().length).toBeGreaterThan(2);
  });

  it("budgets every model it names, or excludes it on the record", () => {
    const budgeted = new Set(COUNCIL.map((model) => model.id));
    const unexplained = modelIdsNamedByTheWorker().filter(
      (id) => !budgeted.has(id) && !EXCLUDED.has(id),
    );
    expect(unexplained).toEqual([]);
  });

  it("keeps every budgeted model in use by the worker", () => {
    // The other direction: a budget entry for a model nobody calls is how the
    // reported allowance stopped describing reality last time.
    const named = new Set(modelIdsNamedByTheWorker());
    expect(COUNCIL.filter((model) => !named.has(model.id))).toEqual([]);
  });

  it("gives every exclusion a written reason", () => {
    for (const [id, reason] of EXCLUDED) {
      expect(reason.length, `${id} has no reason`).toBeGreaterThan(60);
    }
  });

  it("budgets only limits somebody read from the provider", () => {
    expect(COUNCIL.filter((model) => !isVerified(model))).toEqual([]);
  });
});
