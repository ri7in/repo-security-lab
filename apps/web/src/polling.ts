/**
 * What to do when a poll fails.
 *
 * One failure used to end the scan: a single 500, a 429, an empty body or a
 * malformed one exited the loop, and on a report link the page then replaced a
 * fully populated ledger with "that report link is not valid, or it has passed
 * its 30 day expiry". The scan was still running on the server the whole time,
 * and the visitor's only recovery was a reload nobody told them about.
 *
 * Kept apart from the loop because the policy is the part worth pinning and
 * the loop is a `while (true)` around a `fetch`.
 */

/** Consecutive failures tolerated before the scan is given up on. */
export const POLL_ATTEMPTS = 5;

export interface RetryPlan {
  readonly giveUp: boolean;
  readonly waitMs: number;
  /** Shown while retrying. Empty when giving up, because the caller decides. */
  readonly message: string;
}

export function retryPlan(
  failures: number,
  everSucceeded: boolean,
  retryAfterSeconds: number,
): RetryPlan {
  // Nothing has ever worked, so this is not a hiccup: the id is probably not a
  // report at all, and retrying four more times only delays saying so.
  if (!everSucceeded) return { giveUp: true, waitMs: 0, message: "" };
  if (failures >= POLL_ATTEMPTS) return { giveUp: true, waitMs: 0, message: "" };
  return {
    giveUp: false,
    // Backs off, so a service under load is not hammered by every open tab.
    waitMs: Math.max(1_000, retryAfterSeconds * 1_000) * failures,
    message:
      `Lost contact with the service. Still trying (${String(failures)} of ${String(POLL_ATTEMPTS)}). ` +
      "The scan itself keeps running.",
  };
}
