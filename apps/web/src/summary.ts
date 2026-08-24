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
    // "1" over "public repositories" on a one repository account, three lines
    // above a card that has branched on `findings === 1` since it was written.
    {
      value: totalCount(summary),
      label: totalCount(summary) === 1 ? "public repository" : "public repositories",
    },
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

export type RunOutcome = "running" | "done" | "incomplete" | "failed";

/**
 * Whether a finished run may wear the finished colour.
 *
 * Deliberately not folded into percentDone, because the two answer different
 * questions and answering both from the request state is what shipped a false
 * all-clear. How far through counts what has stopped moving, and a failed
 * repository has stopped, so four failed repositories really are at 100. The
 * colour asks whether the run did what it set out to do, and that was read off
 * `summary.state` alone: a request reaches `complete` once every repository is
 * terminal, and failed is terminal, so an account whose four repositories all
 * failed painted a full green bar, a green panel and "All checks done"
 * directly above the red verdict "No repository here was read, so this scan
 * has no result."
 */
export function runOutcome(summary: ScanRequestSummary): RunOutcome {
  if (summary.state === "failed") return "failed";
  if (summary.state !== "complete") return "running";
  const totals = summary.repositoryTotals;
  // The same pair the "did not finish" card counts. A fork or a repository
  // with no commit is a correct outcome and does not take the colour off.
  return totals.failed + totals.partial > 0 ? "incomplete" : "done";
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
  // Every caller already frames this: couldNotStart prefixes "This scan could
  // not start." and got "This scan could not start. The scan could not be
  // started. Check your connection..." out of it, which is what any offline,
  // DNS or non-JSON 5xx failure printed in the banner.
  return hasReport
    ? "Something went wrong that this page cannot explain. Try again in a few minutes, and the report id in the address bar is what to send in if it keeps happening."
    : "Check your connection and try again in a few minutes.";
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
      // A one repository account whose only repository failed read "0 of 1
      // repositories finished.", while the return directly below this one has
      // carried the singular since it was written.
      return `${String(total - missed)} of ${String(total)} ${total === 1 ? "repository" : "repositories"} finished.`;
    }
    return `All ${String(total)} ${total === 1 ? "repository" : "repositories"} finished.`;
  }
  // Same singular. This is the running line, so on a one repository account
  // "0 of 1 repositories finished so far." was on screen for the whole scan
  // rather than for the moment at the end of it.
  return `${String(terminalCount(summary))} of ${String(total)} ${total === 1 ? "repository" : "repositories"} finished so far.`;
}

/**
 * The line under the title on the printed page.
 *
 * Its only guard was `state === "failed"`, so every other case got the wording
 * of a clean result. An account whose four repositories all failed reaches
 * `complete`, because `failed` is a terminal repository state, and printed
 * "4 public repositories in the account, nothing found, scanned <date>"
 * directly above the verdict "No repository here was read, so this scan has no
 * result." Mid-scan it printed the same sentence over "5 of 11 repositories
 * finished so far": the cover is not gated on the Print button, style.css
 * gives .print-cover an unconditional display block inside @media print, so
 * any Cmd+P or Save as PDF while a scan is running renders it.
 *
 * The date arrives already formatted so the wording can be tested without a
 * locale, and the product name is appended by the caller.
 */
export function printCoverText(
  summary: ScanRequestSummary,
  /**
   * Repositories the secret scan read in full, from the rows' own coverage.
   * Repository state cannot answer this: a repository whose secret scan
   * finished and whose AI review failed is `partial`.
   */
  readInFull: number,
  findings: number,
  when: string,
): string {
  if (summary.state === "failed") {
    return `This scan stopped before it finished, so it has no result · ${when}`;
  }
  // Paper keeps whatever was true when the button was pressed, so a page
  // printed mid-scan has to say it is a snapshot of a run still going rather
  // than report a count of findings nobody has finished collecting.
  if (summary.state !== "complete") {
    const running = totalCount(summary);
    return (
      "This scan had not finished when this page was printed, so it has no result yet · " +
      `${String(terminalCount(summary))} of ${String(running)} ${running === 1 ? "repository" : "repositories"} finished so far · ` +
      `as of ${when}`
    );
  }
  const total = totalCount(summary);
  // Nothing to scan is not a clean scan, the same distinction the ledger and
  // the empty findings panel already make.
  if (total === 0) {
    return `This account has no public repositories, so there was nothing to scan · ${when}`;
  }
  // Word for word what the verdict below it says, because "nothing found" over
  // a scan that read no code at all is the false all-clear this whole page
  // exists to avoid.
  //
  // Only when there is nothing to report, though. A repository the scanner
  // read part of still publishes what it found before it stopped, and so does
  // the AI review over a repository whose secret scan failed, so without the
  // findings guard this sentence printed directly above a table of exposed
  // credentials. summarizeVerdict tests the findings before the coverage for
  // exactly the same reason.
  if (readInFull === 0 && findings === 0) {
    return `No repository here was read, so this scan has no result · ${when}`;
  }
  return (
    `${String(total)} public ${total === 1 ? "repository" : "repositories"} in the account · ` +
    `${findings === 0 ? "nothing found" : `${String(findings)} finding${findings === 1 ? "" : "s"}`} · ` +
    `scanned ${when}`
  );
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

