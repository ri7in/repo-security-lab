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

  const steps: { step: Step; state: StepState; percent: number }[] = [];
  let active: Step | null = null;
  for (const step of STEP_ORDER) {
    const { done, total } = progress[step];
    const complete = all > 0 && done >= total;
    // Exactly one step is active: the first unfinished one. Marking several at
    // once is what made the old panel look like nothing was happening.
    const isActive = !complete && active === null && !finished && !stopped;
    if (isActive) active = step;
    steps.push({
      step,
      state: complete ? "done" : isActive ? "active" : "todo",
      percent: all === 0 ? 0 : Math.round((done / total) * 100),
    });
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
        ? `All ${String(all)} ${all === 1 ? "repository has" : "repositories have"} been checked.`
        : all === 0
          ? "Looking up the account."
          : `${String(terminal)} of ${String(all)} repositories finished.`,
    finished: finished || stopped,
  };
}
