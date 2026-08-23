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

describe("a scan that stopped", () => {
  it("has no verdict at all, reassuring or otherwise", () => {
    // A failed lookup left an empty ledger, and an empty ledger produced
    // "Nothing to check, this account has no public repositories", which is a
    // clean bill of health for a scan that never ran. On a security tool a
    // false all-clear is the worst output there is.
    const decided = summarizeVerdict("ri7in", [], [], "GitHub had no such account.");
    expect(decided.tone).toBe("concern");
    expect(decided.text).toContain("no result");
    expect(decided.text).toContain("GitHub had no such account.");
    expect(decided.text.toLowerCase()).not.toContain("nothing to check");
    expect(decided.text.toLowerCase()).not.toContain("nothing exposed");
  });

  it("stays a concern even when repositories did finish before it stopped", () => {
    const decided = summarizeVerdict(
      "ri7in",
      [repository(), repository({ repositoryId: 2 })],
      [],
      "The download failed part way through.",
    );
    expect(decided.tone).toBe("concern");
    expect(decided.text).not.toContain("came back clean");
  });
});

describe("the verdict", () => {
  it("reads clear only when every repository was actually checked", () => {
    const decided = summarizeVerdict(
      "ri7in",
      [repository({ repositoryId: 1 }), repository({ repositoryId: 2 })],
      [],
    );
    expect(decided.tone).toBe("clear");
    // Names the checker rather than promising "clean": the secret scan covers
    // every repository, the code review covers at most three, and a headline
    // that blurs the two overstates the whole result.
    expect(decided.text).toContain("all 2 public repositories");
    expect(decided.text.toLowerCase()).not.toContain("came back clean");
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
    // "Could not be checked" told people something had broken when the usual
    // cause is a fork this tool deliberately does not scan.
    expect(decided.text).toContain("1 was skipped or could not be read");
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

  it("still admits what it did not look at when it did find something", () => {
    // The findings branch used to return early with "every one is listed
    // below", claiming completeness over repositories nobody examined.
    const decided = summarizeVerdict(
      "ri7in",
      [repository({ state: "cancelled" }), repository({ repositoryId: 2 })],
      [finding()],
    );
    expect(decided.text).toContain("not fully checked");
    expect(decided.text).toContain("there may be more");
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
      "all 1 public repository",
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
