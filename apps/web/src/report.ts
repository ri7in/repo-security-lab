import { branding } from "@app/branding";
import type {
  PublicFinding,
  RepositoryRow,
  ScanRequestSummary,
} from "@app/contracts";
import { aiCoverageLabel, coverageLabel, repositoryLabel } from "./labels.js";
import type { PdfReport } from "./pdf.js";

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
  return {
    title: `Security report for ${state.summary.username}`,
    meta:
      `${String(state.repositories.length)} public ` +
      `${state.repositories.length === 1 ? "repository" : "repositories"} examined - ` +
      `scanned ${scannedAt.toISOString().slice(0, 16).replace("T", " ")} UTC - ` +
      branding.productDisplayName,
    verdict,
    sections: [
      {
        heading: "What was found",
        note: "File paths and line numbers only. No source code and no secret values.",
        emptyText: "Nothing was found.",
        columns: [
          // Weighted so that no header truncates and "more than twenty", the
          // longest occurrence bucket, still fits whole.
          { title: "Repository", weight: 4.5 },
          { title: "What was found", weight: 4 },
          { title: "Severity", weight: 2 },
          { title: "Occurrences", weight: 3.5 },
          { title: "Where", weight: 7, keep: "tail" },
        ],
        rows: state.findings.map((finding) => [
          names.get(finding.repository_id) ??
            `repository ${String(finding.repository_id)}`,
          finding.rule_id.replaceAll("-", " "),
          finding.severity,
          finding.occurrence_bucket.replaceAll("_", " "),
          formatLocations(finding.locations),
        ]),
      },
      {
        heading: "What was covered",
        emptyText: "No repositories were examined.",
        columns: [
          { title: "Repository", weight: 4 },
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
      'Public report, retained for 30 days. Characters outside printable ASCII are shown as "?". ' +
      origin,
  };
}

/** The file name a downloaded report lands under. */
export function reportFileName(summary: ScanRequestSummary): string {
  return `security-report-${summary.username}-${new Date(summary.updatedAt).toISOString().slice(0, 10)}.pdf`;
}
