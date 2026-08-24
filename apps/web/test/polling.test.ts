import { describe, expect, it } from "vitest";
import { POLL_ATTEMPTS, retryPlan } from "../src/polling.js";

/**
 * One failed poll used to end a running scan and replace a fully populated
 * ledger with "that report link is not valid, or it has passed its 30 day
 * expiry", while the scan carried on running on the server.
 */

describe("what to do when a poll fails", () => {
  it("keeps trying after a single failure", () => {
    const plan = retryPlan(1, true, 3);
    expect(plan.giveUp).toBe(false);
    expect(plan.message).toContain("Still trying");
    expect(plan.message).toContain("keeps running");
  });

  it("gives up only after the fifth failure in a row", () => {
    for (let failures = 1; failures < POLL_ATTEMPTS; failures += 1) {
      expect(retryPlan(failures, true, 3).giveUp, `failure ${String(failures)}`).toBe(
        false,
      );
    }
    expect(retryPlan(POLL_ATTEMPTS, true, 3).giveUp).toBe(true);
  });

  it("gives up at once when nothing has ever worked", () => {
    // A first poll that fails usually means the id is not a report at all, and
    // four more attempts only delay saying so.
    expect(retryPlan(1, false, 3).giveUp).toBe(true);
  });

  it("backs off, so a service under load is not hammered by every open tab", () => {
    const first = retryPlan(1, true, 3).waitMs;
    const third = retryPlan(3, true, 3).waitMs;
    expect(third).toBeGreaterThan(first);
    expect(first).toBeGreaterThanOrEqual(1_000);
  });

  it("never waits zero, whatever the server suggested", () => {
    // A hostile or broken retryAfterSeconds must not turn the retry into a
    // tight loop against the API.
    expect(retryPlan(1, true, 0).waitMs).toBeGreaterThanOrEqual(1_000);
    expect(retryPlan(2, true, -5).waitMs).toBeGreaterThanOrEqual(1_000);
  });

  it("says nothing when it is giving up, because the caller decides", () => {
    expect(retryPlan(POLL_ATTEMPTS, true, 3).message).toBe("");
  });
});

describe("what counts as the service having answered", () => {
  it("retries a failure that follows a single good answer", () => {
    // The caller sets everSucceeded on a valid summary rather than on a whole
    // successful poll. Waiting for the repository fetch too meant a 429 on the
    // very first one gave up with no retry: a running scan told "this scan
    // could not start", which is the bug this module exists to prevent.
    const plan = retryPlan(1, true, 3);
    expect(plan.giveUp).toBe(false);
    expect(plan.message).toContain("The scan itself keeps running.");
  });

  it("still gives up when nothing has ever answered", () => {
    expect(retryPlan(1, false, 3).giveUp).toBe(true);
  });
});
