import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REMEDIATION_KEYS, remediationLabel } from "../src/remediation.js";

/**
 * The advice column has to answer every finding this scanner can produce.
 *
 * The keys are fixed on the trusted side, so a new one arrives as a source
 * edit in another package and nothing here would fail. It would just render
 * the raw slug as though it were advice, which is how this column came to say
 * "rotate secret" and nothing else in the first place.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every remediation key any manifest can issue, read from the manifests. */
function keysInUse(): readonly string[] {
  const sources = [
    "packages/scanners/src/manifest.ts",
    "packages/scanners/src/ai-manifest.ts",
    "packages/scanners/src/zizmor-manifest.ts",
  ];
  const keys = new Set<string>();
  for (const relative of sources) {
    let source: string;
    try {
      source = readFileSync(path.join(ROOT, relative), "utf8");
    } catch {
      continue;
    }
    // Both the literal form and the lookup-table form.
    for (const match of source.matchAll(/remediationKey:\s*"([a-z-]+)"/g)) {
      keys.add(match[1] ?? "");
    }
    const table = /const REMEDIATIONS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
    if (table !== null) {
      for (const match of (table[1] ?? "").matchAll(/:\s*"([a-z-]+)"/g)) {
        keys.add(match[1] ?? "");
      }
    }
  }
  keys.delete("");
  return [...keys];
}

describe("finding advice", () => {
  it("finds the keys, so this guard cannot pass vacuously", () => {
    const keys = keysInUse();
    expect(keys.length).toBeGreaterThanOrEqual(10);
    expect(keys).toContain("rotate-secret");
  });

  it("answers every key a manifest can issue", () => {
    const missing = keysInUse().filter((key) => !REMEDIATION_KEYS.includes(key));
    expect(missing).toEqual([]);
  });

  it("carries no advice for a key nobody issues", () => {
    // A stale entry is not a bug a reader ever sees, but it is dead weight in
    // a table that has to be read to be maintained.
    const used = new Set(keysInUse());
    expect(REMEDIATION_KEYS.filter((key) => !used.has(key))).toEqual([]);
  });

  it("gives advice a reader can act on, not a restatement of the problem", () => {
    for (const key of REMEDIATION_KEYS) {
      const advice = remediationLabel(key);
      // Short enough for a table cell.
      expect(advice.short.length, `${key} short is too long`).toBeLessThan(32);
      // Long enough to actually say what to do.
      expect(advice.detail.length, `${key} detail is too thin`).toBeGreaterThan(120);
      expect(advice.detail).not.toContain("—");
    }
  });

  it("starts each short form with a verb, because it is an instruction", () => {
    for (const key of REMEDIATION_KEYS) {
      const first = remediationLabel(key).short.split(" ")[0] ?? "";
      expect(first[0], `${key} does not start with a capital`).toBe(
        first[0]?.toUpperCase(),
      );
    }
  });

  it("makes a missing entry visible rather than passing off a slug as advice", () => {
    const unknown = remediationLabel("something-nobody-wrote");
    expect(unknown.short).toBe("something nobody wrote");
    expect(unknown.detail).toContain("No guidance");
  });
});
