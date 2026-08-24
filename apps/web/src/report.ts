import { branding } from "@app/branding";
import type {
  PublicFinding,
  RepositoryRow,
  ScanRequestSummary,
} from "@app/contracts";
import { aiCoverageLabel, coverageLabel, repositoryLabel } from "./labels.js";
import {
  fullyScannedCount,
  nothingFoundText,
  uncheckedCount,
} from "./verdict.js";
import type { PdfReport } from "./pdf.js";
import { remediationLabel } from "./remediation.js";
import { ruleName } from "./rule-name.js";

export interface ReportState {
  readonly summary: ScanRequestSummary;
  readonly repositories: readonly RepositoryRow[];
  readonly findings: readonly PublicFinding[];
}

/** One location, written the way every surface writes it. */
function at(entry: { path: string; startLine: number }): string {
  return `${entry.path}:${String(entry.startLine)}`;
}

/**
 * How many locations the fixed-width table cell names before it counts the
 * rest. Shared with `hiddenLocations` on purpose: if the two ever disagreed,
 * the cell and its tooltip would either repeat a path or drop one between them.
 */
const CELL_FITS = 3;

/**
 * Renders where a finding sits.
 *
 * Findings with no location render as words rather than an empty cell, so "we
 * did not locate this" stays distinct from "this has no location". A path comes
 * from the scanned repository, so it is attacker-controlled text and every
 * caller puts it on the page as text, never as markup. This sentence said
 * "with textContent" until the location cell grew a second child and had to
 * append a text node instead, which is the same guarantee under a new name.
 *
 * Three of them, because this is the table cell and the column is fixed width.
 * The ones it counts instead of naming are not lost: `hiddenLocations` carries
 * them to the tooltip, the screen reader and the printed page, and
 * `allLocations` gives the PDF every one.
 */
export function formatLocations(
  locations: readonly { path: string; startLine: number }[] | undefined,
): string {
  if (locations === undefined || locations.length === 0) return "not located";
  const shown = locations.slice(0, CELL_FITS).map(at).join(", ");
  return locations.length > CELL_FITS
    ? `${shown} and ${String(locations.length - CELL_FITS)} more`
    : shown;
}

/**
 * The locations the cell counted instead of naming.
 *
 * The cell said "and 4 more" and that was the end of them. On the scan of an
 * account with a seven location SQL-injection finding, four real vulnerable
 * files were named nowhere at all: not on hover, not in the reader-only text,
 * not in the downloaded PDF, not on paper. The note above the table promises
 * each finding names the file and the line, and the contract allows twenty
 * locations, so the cell will never be the place that keeps that promise.
 *
 * Empty when the cell already names every one, because a finding with two
 * locations must not grow a hover that repeats what is already in front of the
 * reader.
 *
 * The same attacker-controlled text as above. It lands in a data attribute and
 * in a text node, so no caller may ever put it in markup.
 */
export function hiddenLocations(
  locations: readonly { path: string; startLine: number }[] | undefined,
): string {
  if (locations === undefined || locations.length <= CELL_FITS) return "";
  const rest = locations.slice(CELL_FITS);
  const lead =
    rest.length === 1 ? "The other one" : `The other ${String(rest.length)}`;
  return `${lead}: ${rest.map(at).join(", ")}`;
}

/**
 * Every location, for the surfaces that can wrap.
 *
 * The findings section of the PDF uses the list layout, which gives a value as
 * many lines as it needs, so nothing there forced the cell's three on it. It
 * inherited them anyway: a seven location finding downloaded as three paths
 * and "and 4 more", and the file offered the reader no other way to find the
 * four.
 */
export function allLocations(
  locations: readonly { path: string; startLine: number }[] | undefined,
): string {
  if (locations === undefined || locations.length === 0) return "not located";
  return locations.map(at).join(", ");
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
  // Read in full, which is what the verdict printed under this line counts.
  // secretScannedCount also counts a repository the scanner only partly read,
  // so a report with five complete and two partial said "7 of 7 public
  // repositories examined" directly above "Nothing exposed in the 5
  // repositories the secret scan read in full. 2 did not finish."
  const scanned = fullyScannedCount(state.repositories);
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
          fullyScannedCount(state.repositories),
          uncheckedCount(state.repositories),
          "Nothing was found. No exposed credential matched any of the rules Gitleaks 8.30.1 runs, at the commit that was read. That is not a guarantee the code is secure.",
        ).text,
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
          ruleName(finding.rule_id),
          finding.severity,
          formatCount(finding.occurrence_bucket),
          allLocations(finding.locations),
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
      "Public report: anyone holding the link can read it, and it is deleted 30 days " +
      "after its last update. Where the AI code review ran, public source files went to " +
      "OpenRouter and excerpts around secret-scan findings went to OpenRouter, Google and " +
      "Groq, which may retain or train on them; the privacy page has the full statement. " +
      'This file uses a basic font, so accents and non-Latin characters in a file path appear as "?"; ' +
      "the web report shows them correctly. " +
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
