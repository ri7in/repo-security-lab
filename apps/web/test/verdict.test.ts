import { describe, expect, it } from "vitest";
import type { PublicFinding, RepositoryRow } from "@app/contracts";
import {
  emptyLedgerText,
  nothingFoundText,
  secretScannedCount,
  skippedOnPurposeCount,
  summarizeVerdict,
  uncheckedCount,
} from "../src/verdict.js";

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
    expect(decided.text).toContain("read 2 of 2 public repositories");
    expect(decided.text.toLowerCase()).not.toContain("came back clean");
    // It reads one commit, not the history, so it says so.
    expect(decided.text).toContain("current commit");
  });

  it("does not present a deliberately skipped fork as a gap", () => {
    // A report where every intended check succeeded still said five of
    // twenty-three were not fully checked, four of which were forks whose own
    // label says anything found in them would be somebody else's to fix.
    const decided = summarizeVerdict(
      "ri7in",
      [repository({ repositoryId: 1 }), repository({ repositoryId: 2, state: "cancelled" })],
      [],
    );
    expect(decided.tone).toBe("clear");
    expect(decided.text).toContain("skipped on purpose");
    expect(decided.text).not.toContain("did not finish");
  });

  it("will not call a scan clear when a repository failed", () => {
    const decided = summarizeVerdict(
      "ri7in",
      [repository({ repositoryId: 1 }), repository({ repositoryId: 2, state: "failed" })],
      [],
    );
    expect(decided.tone).toBe("partial");
    expect(decided.text).toContain("did not finish");
  });

  it("treats a partly finished repository as not finished", () => {
    // "partial" means at least one engine did not complete, which is exactly
    // the case where a clean-looking result is least trustworthy.
    expect(
      summarizeVerdict(
        "ri7in",
        [repository(), repository({ repositoryId: 2, state: "partial" })],
        [],
      ).tone,
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
      [repository({ state: "failed" }), repository({ repositoryId: 2 })],
      [finding()],
    );
    expect(decided.text).toContain("did not finish");
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
      "1 of 1 public repository at its",
    );
    expect(
      summarizeVerdict("ri7in", [repository()], [finding()]).text,
    ).toContain("1 thing to fix");
  });

  it("separates what went wrong from what was skipped on purpose", () => {
    const rows = [
      repository({ repositoryId: 1, state: "complete" }),
      repository({ repositoryId: 2, state: "failed" }),
      repository({ repositoryId: 3, state: "cancelled" }),
      repository({ repositoryId: 4, state: "partial" }),
      repository({ repositoryId: 5, state: "empty" }),
    ];
    // A fork and a repository with no commit are correct outcomes; a failed
    // and a partly scanned repository are not.
    expect(uncheckedCount(rows)).toBe(2);
    expect(skippedOnPurposeCount(rows)).toBe(2);
  });

  it("counts what the secret scan read from its own coverage", () => {
    // A repository can be terminal without the scanner ever opening it, and
    // the clear verdict names the secret scan specifically.
    const coverage = (gitleaks: string) =>
      ({
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks,
        osv: "unsupported",
        zizmor: "unsupported",
        opengrep: "unsupported",
        ai: "unsupported",
      }) as RepositoryRow["coverage"];
    expect(
      secretScannedCount([
        repository({ repositoryId: 1, coverage: coverage("complete") }),
        repository({ repositoryId: 2, coverage: coverage("partial") }),
        repository({ repositoryId: 3, coverage: coverage("not_applicable") }),
        repository({ repositoryId: 4, coverage: coverage("failed") }),
      ]),
    ).toBe(2);
  });
});

describe("the lines that stand in for an absent result", () => {
  it("does not tell a finished empty account that its scan stopped early", () => {
    // An account with no public repositories reaches `complete` with an empty
    // ledger, and was handed the sentence written for a scan that died during
    // discovery, under a heading reading "Scan finished".
    expect(emptyLedgerText(false)).toBe(
      "This account has no public repositories, so there was nothing to scan.",
    );
    expect(emptyLedgerText(false)).not.toContain("stopped");
    expect(emptyLedgerText(true)).toContain("stopped before it got that far");
  });

  it("does not paint an all-clear over a ledger of failures", () => {
    // Keyed on the repository count, so an account whose repositories all
    // failed still got the green panel and the sentence crediting Gitleaks
    // with reading a commit, directly under three red rows. A request reaches
    // `complete` as soon as every repository is terminal and `failed` is
    // terminal, so this was reachable in production, on screen and in the PDF.
    const standard = "Nothing was found. No exposed credential matched any of the rules Gitleaks 8.30.1 runs, at the commit that was read.";
    const allFailed = nothingFoundText(3, 0, 3, standard);
    expect(allFailed.neutral).toBe(true);
    expect(allFailed.text).not.toContain("Gitleaks");
    expect(allFailed.text).not.toContain("commit");
    expect(allFailed.text).toContain("Nothing here was read");
  });

  it("qualifies the all-clear when some repositories did not finish", () => {
    const standard = "Nothing was found. No exposed credential matched any of the rules Gitleaks 8.30.1 runs, at the commit that was read.";
    const partly = nothingFoundText(23, 19, 1, standard);
    expect(partly.neutral).toBe(true);
    expect(partly.text).toContain("19 repositories the secret scan read");
    expect(partly.text).toContain("1 did not finish");
    expect(partly.text).toContain("not the whole picture");
  });

  it("earns the green only when everything that was meant to run did", () => {
    const standard = "Nothing was found. No exposed credential matched any of the rules Gitleaks 8.30.1 runs, at the commit that was read.";
    const clean = nothingFoundText(23, 23, 0, standard);
    expect(clean.neutral).toBe(false);
    expect(clean.text).toBe(standard);
    // A single repository still reads as English.
    expect(nothingFoundText(2, 1, 1, standard).text).toContain("the 1 repository the secret scan read");
  });

  it("does not credit the scanner with reading a commit it never read", () => {
    const standard = "Nothing was found. No exposed credential matched any of the rules Gitleaks 8.30.1 runs, at the commit that was read.";
    // Over an empty account this green box sat directly under an amber verdict
    // saying there was nothing to check, and the green box wins the reader.
    const empty = nothingFoundText(0, 0, 0, standard).text;
    expect(empty).not.toContain("Gitleaks");
    expect(empty).not.toContain("commit");
    expect(empty).toBe(
      "There was nothing to scan, so nothing was checked and nothing was found.",
    );
    // With repositories in the ledger it is the standing sentence, unchanged.
    expect(nothingFoundText(23, 23, 0, standard).text).toBe(standard);
    expect(nothingFoundText(1, 1, 0, standard).text).toBe(standard);
  });
});
