import { describe, expect, it } from "vitest";
import type {
  PublicFinding,
  RepositoryRow,
  ScanRequestSummary,
} from "@app/contracts";
import {
  formatLocations,
  reportDocument,
  reportFileName,
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
    remediation_key: "rotate-credential",
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
    expect(document_.sections[1]?.rows[0]?.[1]).toBe("Not checked");
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
