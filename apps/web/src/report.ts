import { branding } from "@app/branding";
import type {
  PublicFinding,
  RepositoryRow,
  ScanRequestSummary,
} from "@app/contracts";
import { aiCoverageLabel, coverageLabel, repositoryLabel } from "./labels.js";
import { nothingFoundText, secretScannedCount } from "./verdict.js";
import type { PdfReport } from "./pdf.js";
import { remediationLabel } from "./remediation.js";

export interface ReportState {
  readonly summary: ScanRequestSummary;
  readonly repositories: readonly RepositoryRow[];
  readonly findings: readonly PublicFinding[];
}

/**
 * Renders where a finding sits.
 *
 * Findings with no location render as words rather than an empty cell, so "we
 * did not locate this" stays distinct from "this has no location". Always
 * placed with textContent by the caller and never as markup: a path comes from
 * the scanned repository, so it is attacker-controlled text.
 */
export function formatLocations(
  locations: readonly { path: string; startLine: number }[] | undefined,
): string {
  if (locations === undefined || locations.length === 0) return "not located";
  const shown = locations
    .slice(0, 3)
    .map((entry) => `${entry.path}:${String(entry.startLine)}`)
    .join(", ");
  return locations.length > 3
    ? `${shown} and ${String(locations.length - 3)} more`
    : shown;
}

/** Turns the on-screen report into the document the download button writes. */
export function reportDocument(
  state: ReportState,
  verdict: string,
  origin: string,
): PdfReport {
  const names = new Map(
    state.repositories.map((repository) => [
      repository.repositoryId,
      repository.name,
    ]),
  );
  const scannedAt = new Date(state.summary.updatedAt);
  const scanned = secretScannedCount(state.repositories);
  return {
    title: `Security report for ${state.summary.username}`,
    // "23 public repositories examined" sat directly above a verdict saying
    // five of them were not fully checked.
    meta:
      `${String(scanned)} of ${String(state.repositories.length)} public ` +
      `${state.repositories.length === 1 ? "repository" : "repositories"} examined - ` +
      `scanned ${scannedAt.toLocaleString()} - ` +
      branding.productDisplayName,
    verdict,
    sections: [
      {
        heading: "What was found",
        layout: "list",
        note: "File paths and line numbers only. No source code and no secret values.",
        // Same rule as the page: over an account with no public repositories
        // no commit was read, so the sentence crediting Gitleaks with reading
        // one is false on paper too.
        emptyText: nothingFoundText(
          state.repositories.length,
          "Nothing was found. No exposed credential matched any of the rules Gitleaks 8.30.1 runs, at the commit that was read. That is not a guarantee the code is secure.",
        ),
        columns: [
          // Only the first value titles the block; the rest are labelled
          // lines under it, so nothing here needs a width.
          { title: "Repository", weight: 4 },
          { title: "What was found", weight: 4 },
          { title: "Severity", weight: 1.8 },
          { title: "How many", weight: 3.2 },
          { title: "Where", weight: 6, keep: "tail" },
          { title: "What to do", weight: 4 },
        ],
        rows: state.findings.map((finding) => [
          names.get(finding.repository_id) ??
            `repository ${String(finding.repository_id)}`,
          finding.rule_id.replaceAll("-", " "),
          finding.severity,
          formatCount(finding.occurrence_bucket),
          formatLocations(finding.locations),
          // Both halves. The printed page carries the whole paragraph, and a
          // downloaded PDF that says only "Rotate it" is a worse document
          // than the Print button beside it produces. This module's own
          // header says two words is not advice.
          `${remediationLabel(finding.remediation_key).short}. ${remediationLabel(finding.remediation_key).detail}`,
        ]),
      },
      {
        heading: "What was covered",
        emptyText: "No repositories were examined.",
        columns: [
          // The name is the only value that identifies a row, so it gets the
          // width; the three outcomes are short fixed phrases.
          { title: "Repository", weight: 7 },
          { title: "Status", weight: 3 },
          { title: "Secret scan", weight: 3 },
          { title: "AI code review", weight: 3 },
        ],
        rows: state.repositories.map((repository) => [
          repository.name,
          repositoryLabel(repository.state, repository.reason).text,
          coverageLabel(
            repository.coverage.gitleaks,
            repository.specialistReasons?.gitleaks,
          ).text,
          aiCoverageLabel(repository.coverage.ai).text,
        ]),
      },
    ],
    footer:
      "Public report, retained for 30 days. This file uses a basic font, so accents and " +
      'non-Latin characters in a file path appear as "?"; the web report shows them correctly. ' +
      origin,
  };
}

/**
 * Occurrence buckets as digits.
 *
 * The column asks how many, and "twenty one plus" was the enum name with its
 * underscores swapped out, which reads as machine output next to a severity
 * and a line number.
 */
const COUNTS: Record<string, string> = {
  one: "1",
  two_to_five: "2 to 5",
  six_to_twenty: "6 to 20",
  twenty_one_plus: "21 or more",
};

export function formatCount(bucket: string): string {
  return COUNTS[bucket] ?? bucket.replaceAll("_", " ");
}

/**
 * The file name a downloaded report lands under.
 *
 * Dated the way the page dates it. `toISOString` gave the UTC day, so a report
 * the page labelled 24 August downloaded as `...-2026-08-23.pdf`.
 */
export function reportFileName(summary: ScanRequestSummary): string {
  const at = new Date(summary.updatedAt);
  const day = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
  ].join("-");
  return `security-report-${summary.username}-${day}.pdf`;
}
