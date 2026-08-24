import type { ScanRequestSummary } from "@app/contracts";

/**
 * What the agent panel should show, computed from the ledger alone.
 *
 * Kept separate from the DOM because this is the part that was wrong before:
 * an earlier panel animated on a timer, so a stalled scan and a working one
 * looked identical. Every number below comes from counts the server reported,
 * and none of it can move unless a repository actually moved.
 */

export const STEP_ORDER = ["discover", "download", "scan", "review"] as const;
export type Step = (typeof STEP_ORDER)[number];

/** What the agent writes on its sign while a step is running. */
export const STEP_SIGN: Record<Step, string> = {
  discover: "Finding repositories",
  download: "Downloading snapshots",
  scan: "Scanning for secrets",
  review: "Reviewing findings",
};

export type StepState = "done" | "active" | "todo";
export type LiveState = "idle" | "running" | "done" | "failed";

export interface ProgressModel {
  readonly steps: readonly {
    readonly step: Step;
    readonly state: StepState;
    readonly percent: number;
  }[];
  /** The step the agent is holding, or null when it is holding nothing. */
  readonly active: Step | null;
  readonly signText: string;
  /** The held step's own progress, so a long step still visibly moves. */
  readonly signPercent: number;
  readonly liveState: LiveState;
  readonly livePhase: string;
  readonly livePercent: number;
  readonly liveDetail: string;
  readonly finished: boolean;
}

/**
 * How a finished scan describes its own coverage.
 *
 * Split out because there are three separate reasons a repository is not in
 * the "checked" number and folding any of them in produces a false all-clear:
 * a fork or an empty repository was never opened, and a failed or partial one
 * was opened and did not finish.
 */
function checkedText(all: number, skipped: number, missed: number): string {
  const checked = all - skipped - missed;
  if (skipped === 0 && missed === 0) {
    return `All ${String(all)} ${all === 1 ? "repository has" : "repositories have"} been checked.`;
  }
  const reasons: string[] = [];
  if (skipped > 0) {
    reasons.push(`${String(skipped)} skipped as forks or as empty`);
  }
  if (missed > 0) {
    reasons.push(`${String(missed)} did not finish`);
  }
  return `${String(checked)} of ${String(all)} repositories checked, ${reasons.join(", ")}.`;
}

export function progressModel(summary: ScanRequestSummary): ProgressModel {
  const totals = summary.repositoryTotals;
  const count = (...states: readonly string[]): number =>
    states.reduce(
      (sum, state) => sum + (totals[state as keyof typeof totals] ?? 0),
      0,
    );

  const all = Object.values(totals).reduce((sum, value) => sum + value, 0);
  const terminal = count("complete", "empty", "partial", "failed", "cancelled");
  // A repository counts as past a step only once it has left that step. The
  // earlier version counted "acquiring" as downloaded and "scanning" as
  // scanned, which marked a step finished while it was still running and made
  // the panel jump ahead of the work.
  const downloaded =
    all - count("discovered", "waiting", "leased", "acquiring");
  const scanned =
    all -
    count(
      "discovered",
      "waiting",
      "leased",
      "acquiring",
      "guarding",
      "scanning",
    );

  const finished = summary.state === "complete";
  const skippedOnPurpose = count("cancelled", "empty");
  // Repositories that were meant to finish and did not. They were counted
  // among the checked ones, so a completed scan with a failure announced "all
  // 3 repositories have been checked" in green at 100 percent, directly above
  // a verdict saying one did not finish and a card reading "1 did not finish".
  const missed = count("failed", "partial");
  const stopped = summary.state === "failed";

  const progress: Record<Step, { done: number; total: number }> = {
    // Discovery is finished once the request has left the "accepted" and
    // "discovering" states, which is the only signal the summary carries.
    discover: {
      done:
        summary.state === "accepted" || summary.state === "discovering" ? 0 : all,
      total: all || 1,
    },
    download: { done: downloaded, total: all || 1 },
    scan: { done: scanned, total: all || 1 },
    review: { done: terminal, total: all || 1 },
  };

  // Repositories in each step right now, as opposed to past it.
  //
  // Without this the sign said "Downloading snapshots" for an entire scan: the
  // steps are sequential over the whole account, but the pipeline is per
  // repository, so the first incomplete step is the download from the first
  // second to the last. The step holding the most repositories is the one the
  // agent is actually working on.
  const inFlight: Record<Step, number> = {
    discover: summary.state === "discovering" ? 1 : 0,
    download: count("leased", "acquiring"),
    scan: count("guarding", "scanning", "normalizing"),
    review: count("cleaning", "uploading", "waiting_to_publish"),
  };
  const busiest = STEP_ORDER.reduce<Step | null>((best, step) => {
    if (inFlight[step] === 0) return best;
    if (best === null || inFlight[step] > inFlight[best]) return step;
    return best;
  }, null);

  const steps: { step: Step; state: StepState; percent: number }[] = [];
  let active: Step | null = null;
  let firstIncomplete: Step | null = null;
  for (const step of STEP_ORDER) {
    const { done, total } = progress[step];
    // `finished` covers the account with no public repositories at all: every
    // count is zero, so `done >= total` could never be reached and a finished
    // scan showed four steps that had apparently never started.
    const complete = finished || (all > 0 && done >= total);
    if (!complete && firstIncomplete === null) firstIncomplete = step;
    steps.push({
      step,
      state: complete ? "done" : "todo",
      percent: all === 0 ? 0 : Math.round((done / total) * 100),
    });
  }
  // Exactly one step is active. Marking several at once is what made an
  // earlier panel look like nothing in particular was happening.
  if (!finished && !stopped) active = busiest ?? firstIncomplete;
  const activeEntry = steps.find((entry) => entry.step === active);
  if (activeEntry !== undefined && activeEntry.state !== "done") {
    steps[steps.indexOf(activeEntry)] = { ...activeEntry, state: "active" };
  }

  const held: { done: number; total: number } | null =
    active === null ? null : progress[active];
  const overall =
    all === 0 ? (finished ? 100 : 0) : Math.round((terminal / all) * 100);

  return {
    steps,
    active,
    signText:
      active !== null
        ? STEP_SIGN[active]
        : finished
          ? "All checks done"
          : stopped
            ? "Stopped"
            : "Ready",
    signPercent:
      held === null ? (finished ? 100 : 0) : Math.round((held.done / held.total) * 100),
    // Never "idle". A summary only exists once a request has been accepted, so
    // by the time this runs the scan is under way; "idle" belongs to the panel
    // as it ships, before the first poll answers.
    liveState: stopped ? "failed" : finished ? "done" : "running",
    livePhase: stopped
      ? "Stopped"
      : finished
        ? "Complete"
        : active === null
          ? "Working"
          : STEP_SIGN[active],
    livePercent: overall,
    liveDetail: stopped
      ? "The request stopped before every repository was checked. Details below."
      : finished
        ? all === 0
          ? "This account has no public repositories to scan."
          : // Not "all N have been checked": a fork is in `all` and was never
            // opened, so that sentence sat in green directly above a red
            // verdict saying four were skipped. A failed repository is not a
            // checked one either, and naming it is the whole point of a ledger
            // that refuses to smooth a partial result over.
            checkedText(all, skippedOnPurpose, missed)
        : all === 0
          ? "Looking up the account."
          : `${String(terminal)} of ${String(all)} repositories finished.`,
    finished: finished || stopped,
  };
}
