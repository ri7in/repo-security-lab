import { describe, expect, it } from "vitest";
import { AI_CWE_IDS } from "@app/contracts";
import { AI_BROKER_MANIFEST, aiCweToken } from "@app/scanners";

/**
 * The manifest is the boundary that stops a model writing into a report.
 *
 * Everything a reader sees about an AI finding is looked up here from a
 * number. If a class were missing an entry, or a token collided, the model
 * would either lose a finding or gain the ability to steer which words appear.
 */

describe("AI broker manifest", () => {
  it("covers every CWE the scout is allowed to report", () => {
    expect(AI_BROKER_MANIFEST).toHaveLength(AI_CWE_IDS.length);
    for (const cwe of AI_CWE_IDS) {
      expect(aiCweToken(cwe), `${cwe} has no token`).not.toBeNull();
    }
  });

  it("issues a unique token per class", () => {
    const tokens = AI_BROKER_MANIFEST.map((entry) => entry.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("issues a unique rule id per class", () => {
    const ruleIds = AI_BROKER_MANIFEST.map((entry) => entry.ruleId);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
  });

  it("refuses a class outside the closed vocabulary", () => {
    // The scout schema rejects these first; this is the second line.
    expect(aiCweToken("CWE-9999")).toBeNull();
    expect(aiCweToken("")).toBeNull();
    expect(aiCweToken("__proto__")).toBeNull();
  });

  it("names the weakness rather than only its number", () => {
    // "cwe-89" tells a reader nothing; "sql-injection" tells them everything.
    const token = aiCweToken("CWE-89");
    const entry = AI_BROKER_MANIFEST.find((item) => item.token === token);
    expect(entry?.ruleId).toContain("sql-injection");
  });

  it("carries a distinct remediation per class", () => {
    const keys = AI_BROKER_MANIFEST.map((entry) => entry.remediationKey);
    // One shared "review this" key would make every AI finding say the same
    // unhelpful thing.
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z-]+$/);
  });

  it("grades execution classes above presentation ones", () => {
    const severityOf = (cwe: string): string | undefined =>
      AI_BROKER_MANIFEST.find((entry) => entry.token === aiCweToken(cwe))
        ?.severity;
    // Severity is fixed here precisely so a model cannot inflate its own
    // finding, so the ordering is worth asserting.
    expect(severityOf("CWE-89")).toBe("critical");
    expect(severityOf("CWE-78")).toBe("critical");
    expect(severityOf("CWE-79")).toBe("medium");
  });

  it("never claims high confidence for a reasoned finding", () => {
    for (const entry of AI_BROKER_MANIFEST) {
      expect(entry.confidence).not.toBe("high");
    }
  });
});
