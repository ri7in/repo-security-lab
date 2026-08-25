import { describe, expect, it } from "vitest";
import type {
  PublicFinding,
  RepositoryRow,
  ScanRequestSummary,
} from "@app/contracts";
import {
  allLocations,
  formatLocations,
  hiddenLocations,
  reportDocument,
  reportFileName,
  reportMarkdown,
} from "../src/report.js";

/**
 * The downloaded report has to say the same thing as the page. These tests
 * pin the parts a reader would act on: which repository a finding belongs to,
 * where it is, and that a skipped repository still appears rather than
 * quietly vanishing from the file.
 */

function summary(): ScanRequestSummary {
  return {
    schemaVersion: 1,
    requestId: "req_0000000001",
    username: "ri7in",
    state: "complete",
    repositoryTotals: {},
    coverageTotals: {},
    aiLane: "ai_not_run",
    retryAfterSeconds: 3,
    updatedAt: "2026-08-24T00:30:00.000Z",
  } as ScanRequestSummary;
}

function repository(overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    repositoryId: 7,
    name: "infra-notes",
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

function finding(overrides: Partial<PublicFinding> = {}): PublicFinding {
  return {
    engine: "gitleaks",
    repository_id: 7,
    rule_id: "generic-api-key",
    severity: "critical",
    occurrence_bucket: "one",
    // Was "rotate-credential", which is not one of the twelve keys, so every
    // assertion built on this fixture was testing the unknown-key fallback.
    remediation_key: "rotate-secret",
    locations: [{ path: "infrastructure/k8s/secrets.yaml", startLine: 14 }],
    ...overrides,
  } as PublicFinding;
}

describe("the downloadable report", () => {
  it("names the repository a finding belongs to", () => {
    const document_ = reportDocument(
      { summary: summary(), repositories: [repository()], findings: [finding()] },
      "1 thing to fix.",
      "https://example.test",
    );
    expect(document_.sections[0]?.rows[0]?.[0]).toBe("infra-notes");
    expect(document_.sections[0]?.rows[0]?.[4]).toBe(
      "infrastructure/k8s/secrets.yaml:14",
    );
  });

  it("falls back to the id when a finding names a repository not in the page", () => {
    // The ledger pages; the findings do not have to arrive on the same page.
    const document_ = reportDocument(
      { summary: summary(), repositories: [], findings: [finding()] },
      "",
      "https://example.test",
    );
    expect(document_.sections[0]?.rows[0]?.[0]).toBe("repository 7");
  });

  it("keeps a skipped repository in the coverage table", () => {
    const document_ = reportDocument(
      {
        summary: summary(),
        repositories: [repository({ state: "cancelled", reason: "PRIVATE_SLICE_SCOPE" })],
        findings: [],
      },
      "",
      "https://example.test",
    );
    // A repository that vanished from the file would read as one that passed.
    expect(document_.sections[1]?.rows[0]?.[1]).toBe("Fork, skipped");
  });

  it("carries the verdict it was given rather than inventing one", () => {
    const document_ = reportDocument(
      { summary: summary(), repositories: [], findings: [] },
      "Nothing exposed.",
      "https://example.test",
    );
    expect(document_.verdict).toBe("Nothing exposed.");
  });

  it("names the file after the account and the day it was scanned", () => {
    expect(reportFileName(summary())).toBe("security-report-ri7in-2026-08-24.pdf");
  });

  it("says a finding was not located rather than leaving a blank", () => {
    expect(formatLocations(undefined)).toBe("not located");
    expect(formatLocations([])).toBe("not located");
  });

  it("shows three locations and counts the rest", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      path: `src/file-${String(index)}.ts`,
      startLine: index + 1,
    }));
    expect(formatLocations(many)).toBe(
      "src/file-0.ts:1, src/file-1.ts:2, src/file-2.ts:3 and 4 more",
    );
  });
});

describe("a finding names every location it has", () => {
  // A live scan returned seven locations for one SQL-injection finding and the
  // cell read "php/Job Insert.php:26, php/JobAppTable.php:10,
  // php/ForgotPass.php:7 and 4 more". Four vulnerable files were named
  // nowhere: not on hover, not in the reader-only text, not in the downloaded
  // PDF, not on paper, under a verdict saying all of them are listed with the
  // file and the line.
  const seven = [
    { path: "php/Job Insert.php", startLine: 26 },
    { path: "php/JobAppTable.php", startLine: 10 },
    { path: "php/ForgotPass.php", startLine: 7 },
    { path: "php/Login.php", startLine: 31 },
    { path: "php/Register.php", startLine: 9 },
    { path: "php/Reset.php", startLine: 5 },
    { path: "php/Search.php", startLine: 18 },
  ];
  const every = seven.map((entry) => `${entry.path}:${String(entry.startLine)}`);

  it("names the four the cell only counted", () => {
    const hidden = hiddenLocations(seven);
    for (const one of every.slice(3)) {
      expect(hidden, `${one} is reachable nowhere`).toContain(one);
    }
    // And does not repeat what the cell already shows.
    expect(hidden).not.toContain(every[0]);
  });

  it("says one rather than a digit when a single location is left over", () => {
    // Four locations is the smallest finding that drops anything, and this arm
    // of the copy had no test: "The other 1: php/Login.php:31" reads as
    // machine output beside a cell that already says "and 1 more".
    expect(hiddenLocations(seven.slice(0, 4))).toBe(
      "The other one: php/Login.php:31",
    );
  });

  it("carries nothing when the cell already names them all", () => {
    // A finding with two locations must not grow a hover repeating what is
    // already in front of the reader.
    expect(hiddenLocations(seven.slice(0, 3))).toBe("");
    expect(hiddenLocations(seven.slice(0, 1))).toBe("");
    expect(hiddenLocations([])).toBe("");
    expect(hiddenLocations(undefined)).toBe("");
  });

  it("gives the PDF every location, because its list layout wraps", () => {
    // The findings section is `layout: "list"`, which gives a value as many
    // lines as it needs, so nothing there ever forced the cell's three on it.
    const all = allLocations(seven);
    for (const one of every) {
      expect(all, `${one} is missing from the PDF`).toContain(one);
    }
    expect(all).not.toContain("more");
    expect(allLocations([])).toBe("not located");
  });

  it("leaves the table cell alone, because the column is fixed width", () => {
    expect(formatLocations(seven)).toBe(
      "php/Job Insert.php:26, php/JobAppTable.php:10, php/ForgotPass.php:7 and 4 more",
    );
  });

  it("puts every location in the downloaded report", () => {
    const document_ = reportDocument(
      {
        summary: summary(),
        repositories: [repository()],
        findings: [finding({ locations: seven })],
      },
      "1 thing to fix.",
      "https://example.test",
    );
    const where = String(document_.sections[0]?.rows[0]?.[4] ?? "");
    for (const one of every) {
      expect(where, `${one} is missing from the PDF row`).toContain(one);
    }
  });
});

describe("the downloaded report says as much as the printed one", () => {
  it("carries the whole remediation, not the two-word label", () => {
    // report.ts wrote only remediationLabel(key).short, so the PDF's advice
    // was "Rotate it" while the Print button beside it produced the whole
    // paragraph. remediation.ts's own header says two words is not advice.
    const document_ = reportDocument(
      { summary: summary(), repositories: [repository()], findings: [finding()] },
      "1 thing to fix.",
      "https://example.test",
    );
    const advice = String(document_.sections[0]?.rows[0]?.at(-1) ?? "");
    expect(advice).toContain("Rotate it");
    expect(advice).toContain("anyone who cloned the repository has it");
    expect(advice.length).toBeGreaterThan(60);
  });
});

describe("the report's meta line and its verdict count the same repositories", () => {
  it("counts only the repositories the secret scan read in full", () => {
    // "7 of 7 public repositories examined" printed one line above a verdict
    // reading "Nothing exposed in the 5 repositories the secret scan read in
    // full. 2 did not finish." secretScannedCount counts a partly scanned
    // repository too, so the same repository sat on both sides of that page.
    const document_ = reportDocument(
      {
        summary: summary(),
        repositories: [
          repository({ repositoryId: 1, name: "read-in-full" }),
          repository({
            repositoryId: 2,
            name: "half-read",
            state: "partial",
            coverage: {
              snapshot: "complete",
              archive_guard: "complete",
              gitleaks: "partial",
              osv: "unsupported",
              zizmor: "unsupported",
              opengrep: "unsupported",
              ai: "unsupported",
            },
          }),
        ],
        findings: [],
      },
      "Nothing exposed in the 1 repository the secret scan read in full.",
      "https://example.test",
    );
    expect(document_.meta).toContain("1 of 2 public repositories examined");
    expect(document_.meta).not.toContain("2 of 2");
  });
});

describe("the Markdown copy", () => {
  it("carries the same facts as the page: verdict, findings, coverage", () => {
    const markdown = reportMarkdown(
      {
        summary: summary(),
        repositories: [
          repository(),
          repository({
            repositoryId: 8,
            name: "active-app",
            coverage: { ...repository().coverage, ai: "complete" },
          }),
        ],
        findings: [finding()],
      },
      "1 thing to fix.",
      "https://example.test",
    );
    expect(markdown).toContain("# Security report for ri7in");
    expect(markdown).toContain("1 thing to fix.");
    expect(markdown).toContain("| infra-notes |");
    expect(markdown).toContain("| active-app |");
    expect(markdown).toContain("Deep scanned");
    expect(markdown).toContain("https://example.test");
  });

  it("escapes attacker-controlled text so it cannot reshape the table", () => {
    // A path is written by the scanned repository. In Markdown a pipe is a
    // column boundary and a backtick opens a code span, so an unescaped path
    // could hide the remediation column of its own row.
    const markdown = reportMarkdown(
      {
        summary: summary(),
        repositories: [repository({ name: "infra-notes" })],
        findings: [
          finding({
            locations: [{ path: "src/a|b`c.ts", startLine: 3 }],
          }),
        ],
      },
      "verdict",
      "https://example.test",
    );
    expect(markdown).toContain("src/a\\|b\\`c.ts:3");
    expect(markdown).not.toContain("a|b");
  });

  it("says nothing was found rather than rendering an empty table", () => {
    const markdown = reportMarkdown(
      {
        summary: summary(),
        repositories: [repository()],
        findings: [],
      },
      "verdict",
      "https://example.test",
    );
    expect(markdown).toContain("Nothing was found");
    expect(markdown).not.toContain("| Severity |");
  });
});
