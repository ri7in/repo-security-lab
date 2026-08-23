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
): readonly SummaryCard[] {
  const totals = summary.repositoryTotals;
  return [
    { value: totalCount(summary), label: "public repositories" },
    { value: totals.complete, label: "secret-scanned" },
    { value: reviewed, label: "code-reviewed" },
    {
      value: totals.failed + totals.partial + totals.cancelled,
      label: "not fully checked",
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
export function explainFailure(code: string | undefined): string {
  return (
    (code === undefined ? undefined : failureDetail(code)) ??
    "Something went wrong that this page cannot explain. Try again in a few minutes, and the report id in the address bar is what to send in if it keeps happening."
  );
}

export function statusLine(summary: ScanRequestSummary): string {
  const total = totalCount(summary);
  if (summary.state === "failed") {
    return `Scan stopped. ${explainFailure(summary.reason)}`;
  }
  if (summary.state === "complete") {
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

