import { describe, expect, it } from "vitest";
import type { ScanRequestSummary } from "@app/contracts";
import { progressModel } from "../src/progress.js";

/**
 * The panel's whole claim is that it moves only when the scan moves. These
 * tests are the enforcement of that claim: every state below is derived from a
 * ledger the server wrote, and none of them may be reachable by a scan that
 * has not actually got there.
 */

function summary(
  state: ScanRequestSummary["state"],
  totals: Record<string, number>,
): ScanRequestSummary {
  return {
    schemaVersion: 1,
    requestId: "req_0000000001",
    username: "ri7in",
    state,
    repositoryTotals: {
      discovered: 0,
      waiting: 0,
      leased: 0,
      acquiring: 0,
      guarding: 0,
      scanning: 0,
      normalizing: 0,
      cleaning: 0,
      uploading: 0,
      waiting_to_publish: 0,
      complete: 0,
      empty: 0,
      partial: 0,
      failed: 0,
      cancelled: 0,
      ...totals,
    },
    coverageTotals: {},
    aiLane: "ai_not_run",
    retryAfterSeconds: 3,
    updatedAt: "2026-08-24T00:30:00.000Z",
  } as unknown as ScanRequestSummary;
}

describe("the progress model", () => {
  it("claims nothing while the account is still being looked up", () => {
    const model = progressModel(summary("accepted", {}));
    // A request that exists is running, whatever it has managed so far. The
    // panel only reads "idle" before the first poll answers, which is a state
    // this model is never asked about.
    expect(model.liveState).toBe("running");
    expect(model.livePercent).toBe(0);
    expect(model.signText).toBe("Finding repositories");
    expect(model.liveDetail).toBe("Looking up the account.");
  });

  it("does not mark discovery done while the request is still discovering", () => {
    const model = progressModel(summary("discovering", { waiting: 5 }));
    expect(model.steps[0]?.state).toBe("active");
    expect(model.steps[0]?.percent).toBe(0);
  });

  it("holds exactly one step at a time", () => {
    const model = progressModel(
      summary("scanning", { waiting: 3, scanning: 2, complete: 5 }),
    );
    // Several active steps at once is what made an earlier panel look like
    // nothing in particular was happening.
    expect(model.steps.filter((step) => step.state === "active")).toHaveLength(1);
    expect(model.active).not.toBeNull();
  });

  it("follows where the repositories actually are, not the first gap", () => {
    // The sign read "Downloading snapshots" for an entire scan: the steps run
    // over the whole account while the pipeline runs per repository, so the
    // first incomplete step is the download from the first second to the last.
    const model = progressModel(
      summary("scanning", { complete: 3, scanning: 4, waiting: 3 }),
    );
    expect(model.active).toBe("scan");
    expect(model.signText).toBe("Scanning for secrets");
  });

  it("moves to the review step when that is where the work sits", () => {
    const model = progressModel(
      summary("scanning", { complete: 2, uploading: 3, waiting: 1 }),
    );
    expect(model.active).toBe("review");
  });

  it("falls back to the first unfinished step when nothing is in flight", () => {
    // Between dispatches every repository is waiting and none is in any step.
    const model = progressModel(summary("scanning", { waiting: 8 }));
    expect(model.active).toBe("download");
  });

  it("advances the sign to the step that is actually running", () => {
    // Everything downloaded, nothing published: the scan step is the one in
    // hand, and the sign has to say so.
    const model = progressModel(
      summary("scanning", { scanning: 4, complete: 6 }),
    );
    expect(model.active).toBe("scan");
    expect(model.signText).toBe("Scanning for secrets");
  });

  it("fills the sign with the held step's own progress, not the whole scan's", () => {
    const model = progressModel(
      summary("scanning", { waiting: 8, complete: 2 }),
    );
    // Two of ten repositories are terminal, so the overall bar is 20 percent.
    expect(model.livePercent).toBe(20);
    // The held step is the download, which two of ten have passed, so its own
    // bar is also 20. The point is that they are computed separately: a long
    // step must still visibly move while the overall figure barely does.
    expect(model.active).toBe("download");
    expect(model.signPercent).toBe(20);
  });

  it("reaches a hundred percent only when every repository is terminal", () => {
    expect(
      progressModel(summary("scanning", { complete: 22, waiting: 1 })).livePercent,
    ).toBe(96);
    expect(
      progressModel(summary("complete", { complete: 23 })).livePercent,
    ).toBe(100);
  });

  it("counts a skipped or failed repository as finished, because it is", () => {
    const model = progressModel(
      summary("complete", { complete: 20, cancelled: 2, failed: 1 }),
    );
    expect(model.livePercent).toBe(100);
    // Not "all 23 have been checked": two were forks and were never opened,
    // and that sentence sat in green directly above a red verdict saying so.
    expect(model.liveDetail).toBe(
      "21 of 23 repositories checked, 2 skipped as forks or as empty.",
    );
  });

  it("holds nothing once the request is complete", () => {
    const model = progressModel(summary("complete", { complete: 3 }));
    expect(model.active).toBeNull();
    expect(model.signText).toBe("All checks done");
    expect(model.signPercent).toBe(100);
    expect(model.liveState).toBe("done");
    expect(model.steps.every((step) => step.state === "done")).toBe(true);
    expect(model.finished).toBe(true);
  });

  it("stops rather than pretending to still be working when a request fails", () => {
    const model = progressModel(summary("failed", { waiting: 2, complete: 1 }));
    expect(model.liveState).toBe("failed");
    expect(model.signText).toBe("Stopped");
    expect(model.active).toBeNull();
    // Still terminal, so the visitor is pointed at whatever result exists.
    expect(model.finished).toBe(true);
    expect(model.steps.some((step) => step.state === "active")).toBe(false);
  });

  it("gets the singular right for a single repository", () => {
    expect(progressModel(summary("complete", { complete: 1 })).liveDetail).toBe(
      "All 1 repository has been checked.",
    );
  });

  it("only says all when all of them really were", () => {
    expect(progressModel(summary("complete", { complete: 5 })).liveDetail).toBe(
      "All 5 repositories have been checked.",
    );
  });

  it("never divides by zero on an account with no repositories", () => {
    const model = progressModel(summary("complete", {}));
    expect(model.livePercent).toBe(100);
    expect(model.steps.every((step) => step.percent === 0)).toBe(true);
  });

  it("marks every step done on a finished account with no repositories", () => {
    // `done >= total` can never be reached when every count is zero, so a
    // finished scan showed a green live block, a hundred percent, and four
    // steps that had apparently never started.
    const model = progressModel(summary("complete", {}));
    expect(model.steps.every((step) => step.state === "done")).toBe(true);
    expect(model.finished).toBe(true);
  });

  it("reports each step's own progress, not one running total", () => {
    // With one repository scanned and one still being scanned out of eight,
    // the download has happened for two and the review for one. Each figure
    // counts what genuinely passed that step.
    const model = progressModel(
      summary("scanning", { complete: 1, scanning: 1, waiting: 6 }),
    );
    const percent = (step: string) =>
      model.steps.find((entry) => entry.step === step)?.percent;
    expect(percent("discover")).toBe(100);
    expect(percent("download")).toBe(25);
    expect(percent("scan")).toBe(13);
    expect(percent("review")).toBe(13);
  });

  it("shows nothing on a step nothing has reached", () => {
    const model = progressModel(summary("scanning", { waiting: 8 }));
    const percent = (step: string) =>
      model.steps.find((entry) => entry.step === step)?.percent;
    expect(percent("download")).toBe(0);
    expect(percent("scan")).toBe(0);
    expect(percent("review")).toBe(0);
  });
});
