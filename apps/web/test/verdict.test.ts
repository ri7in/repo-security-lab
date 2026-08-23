import { describe, expect, it } from "vitest";
import type { PublicFinding, RepositoryRow } from "@app/contracts";
import { summarizeVerdict, uncheckedCount } from "../src/verdict.js";

/**
 * The verdict is the only line most visitors will read closely, so the tests
 * here are about the claim it makes rather than its wording. A repository that
 * was never examined must never be counted towards a clean result.
 */

function repository(overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    repositoryId: 1,
    name: "fixture-repo",
    state: "complete",
    coverage: {
      snapshot: "complete",
      archive_guard: "complete",
      gitleaks: "complete",
      osv: "unsupported",
      zizmor: "unsupported",
      opengrep: "unsupported",
      ai: "unsupported",
    },
    aiLane: "ai_not_run",
    ...overrides,
  };
}

function finding(): PublicFinding {
  return {
    rule_id: "generic-api-key",
    severity: "critical",
    occurrence_bucket: "one",
    remediation_key: "rotate-credential",
    engine: "gitleaks",
    repository_id: 1,
  } as PublicFinding;
}

describe("the verdict", () => {
  it("reads clear only when every repository was actually checked", () => {
    const decided = summarizeVerdict(
      "ri7in",
      [repository({ repositoryId: 1 }), repository({ repositoryId: 2 })],
      [],
    );
    expect(decided.tone).toBe("clear");
    expect(decided.text).toContain("All 2 public repositories");
  });

  it("will not call a scan clear when a repository was skipped", () => {
    // A fork, or a repository too large for the free tier. Neither was looked
    // at, so neither may hold up a clean headline.
    const decided = summarizeVerdict(
      "ri7in",
      [repository({ repositoryId: 1 }), repository({ repositoryId: 2, state: "cancelled" })],
      [],
    );
    expect(decided.tone).toBe("partial");
    expect(decided.text).toContain("1 could not be checked");
  });

  it("will not call a scan clear when a repository failed", () => {
    expect(
      summarizeVerdict("ri7in", [repository({ state: "failed" })], []).tone,
    ).toBe("partial");
  });

  it("treats a partly finished repository as not finished", () => {
    // "partial" means at least one engine did not complete, which is exactly
    // the case where a clean-looking result is least trustworthy.
    expect(
      summarizeVerdict("ri7in", [repository({ state: "partial" })], []).tone,
    ).toBe("partial");
  });

  it("leads with the findings whenever there are any", () => {
    const decided = summarizeVerdict("ri7in", [repository()], [finding()]);
    expect(decided.tone).toBe("concern");
    expect(decided.text.startsWith("1 thing to fix")).toBe(true);
  });

  it("counts findings before it counts skipped repositories", () => {
    // A scan that both found something and skipped something is a concern,
    // not a partial. The thing that needs fixing comes first.
    const decided = summarizeVerdict(
      "ri7in",
      [repository({ state: "cancelled" }), repository({ repositoryId: 2 })],
      [finding()],
    );
    expect(decided.tone).toBe("concern");
  });

  it("does not call an empty account clean", () => {
    // Zero repositories checked, zero findings. "All 0 came back clean" would
    // be technically true and completely misleading.
    const decided = summarizeVerdict("ri7in", [], []);
    expect(decided.tone).toBe("partial");
    expect(decided.text).toContain("no public repositories");
  });

  it("gets the singular right for one repository and one finding", () => {
    expect(summarizeVerdict("ri7in", [repository()], []).text).toContain(
      "All 1 public repository",
    );
    expect(
      summarizeVerdict("ri7in", [repository()], [finding()]).text,
    ).toContain("1 thing to fix");
  });

  it("counts every state that means not examined", () => {
    expect(
      uncheckedCount([
        repository({ repositoryId: 1, state: "complete" }),
        repository({ repositoryId: 2, state: "failed" }),
        repository({ repositoryId: 3, state: "cancelled" }),
        repository({ repositoryId: 4, state: "partial" }),
        repository({ repositoryId: 5, state: "empty" }),
      ]),
    ).toBe(3);
  });
});
