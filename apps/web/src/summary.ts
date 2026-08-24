import type { ScanRequestSummary } from "@app/contracts";
import { failureDetail } from "./labels.js";

/**
 * The numbers above the ledger, and the line under them.
 *
 * Extracted because the cards have been wrong twice. They counted "terminal"
 * repositories, which is a phrase out of the state machine, and filed a
 * deliberately skipped fork under "needs attention" as though the visitor had
 * to do something about it. Then "fully scanned" sat above a table where most
 * rows read "Not reviewed", because the secret scan reaches every repository
 * and the code review reaches three.
 */

export interface SummaryCard {
  readonly value: number;
  readonly label: string;
}

const TERMINAL = ["complete", "empty", "partial", "failed", "cancelled"] as const;

export function terminalCount(summary: ScanRequestSummary): number {
  return TERMINAL.reduce(
    (total, state) => total + summary.repositoryTotals[state],
    0,
  );
}

export function totalCount(summary: ScanRequestSummary): number {
  return Object.values(summary.repositoryTotals).reduce(
    (sum, count) => sum + count,
    0,
  );
}

export function summaryCards(
  summary: ScanRequestSummary,
  reviewed: number,
  findings: number,
  /** From the rows' own coverage, not from repository state. */
  secretScanned: number,
): readonly SummaryCard[] {
  const totals = summary.repositoryTotals;
  return [
    { value: totalCount(summary), label: "public repositories" },
    // `totals.complete` counts repositories where every engine finished, so a
    // repository whose secret scan completed and whose AI review failed was
    // missing from this card while the ledger row beside it said "Fully
    // scanned" and the PDF said it had been examined. Three numbers for one
    // idea, two of them disagreeing.
    { value: secretScanned, label: "secret-scanned" },
    { value: reviewed, label: "code-reviewed" },
    // Only what went wrong. A skipped fork is a correct outcome and counting
    // it here implied the visitor had something to do about it.
    {
      value: totals.failed + totals.partial,
      label: "did not finish",
    },
    { value: findings, label: findings === 1 ? "finding" : "findings" },
  ];
}

/** How far through, as a whole number. */
export function percentDone(summary: ScanRequestSummary): number {
  const total = totalCount(summary);
  if (total === 0) return summary.state === "complete" ? 100 : 0;
  return Math.round((terminalCount(summary) / total) * 100);
}

/**
 * Turns a stored failure code into a sentence.
 *
 * The status line used to print the code with its underscores swapped for
 * spaces, so a visitor who hit the daily database ceiling read "Request
 * stopped: d1 write reserve." D1 is Cloudflare's database product, and the
 * explanations already existed one file away and were never consulted.
 */
export function explainFailure(
  code: string | undefined,
  /** False before a request exists, when there is no id to send in. */
  hasReport = true,
): string {
  const explained = code === undefined ? undefined : failureDetail(code);
  if (explained !== undefined) return explained;
  // The old single fallback told people to send in "the report id in the
  // address bar" over a request that was never created and had no id.
  return hasReport
    ? "Something went wrong that this page cannot explain. Try again in a few minutes, and the report id in the address bar is what to send in if it keeps happening."
    : "The scan could not be started. Check your connection and try again in a few minutes.";
}

export function statusLine(summary: ScanRequestSummary): string {
  const total = totalCount(summary);
  // Only that it stopped. The reason belongs to the verdict banner directly
  // above this line, and printing it in both put the same sentence on the page
  // twice, word for word.
  if (summary.state === "failed") return "This scan stopped before it finished.";
  if (summary.state === "complete") {
    // An account with no public repositories reaches `complete` with nothing
    // in it, and "All 0 repositories finished." was the line under a heading
    // reading "Scan finished".
    if (total === 0) return "This account has no public repositories to scan.";
    // "All N repositories finished." sat seventeen pixels under a verdict
    // reading "1 repository did not finish, so there may be more", and under
    // "9 repositories did not finish" on a larger account.
    const missed = summary.repositoryTotals.failed + summary.repositoryTotals.partial;
    if (missed > 0) {
      return `${String(total - missed)} of ${String(total)} repositories finished.`;
    }
    return `All ${String(total)} ${total === 1 ? "repository" : "repositories"} finished.`;
  }
  return `${String(terminalCount(summary))} of ${String(total)} repositories finished so far.`;
}

/** The heading over the result, which must not stay stale once it is done. */
export function statusHeading(summary: ScanRequestSummary): string {
  if (summary.state === "complete") return "Scan finished";
  if (summary.state === "failed") return "Scan stopped early";
  return "Scan in progress";
}

/**
 * The providers, as a person would write them.
 *
 * The ids are internal and lowercase, and joining three of them with "and"
 * produced "openrouter and groq and gemini" in the footer sentence that tells
 * people where their code goes.
 */
const PROVIDER_NAMES: Record<string, string> = {
  openrouter: "OpenRouter",
  groq: "Groq",
  gemini: "Google",
};

export function providerNames(providers: readonly string[]): string {
  const named = providers.map((id) => PROVIDER_NAMES[id] ?? id);
  if (named.length === 0) return "an external model provider";
  if (named.length === 1) return named[0] ?? "";
  return `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
}

