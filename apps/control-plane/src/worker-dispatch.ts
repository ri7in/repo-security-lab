import { branding } from "@app/branding";
import { LEASED_REPOSITORY_STATES } from "@app/core";
import type { D1Database } from "@app/store-d1";

/**
 * Starts the scan worker on demand.
 *
 * A visitor pressing the button dispatches one GitHub Actions run, instead of
 * a schedule waking up every few minutes to find an empty queue. That is both
 * faster for the visitor and a far lighter load on GitHub: the runner only
 * exists when there is real work, which is what keeps this inside the
 * "low burden" allowance in GitHub's Actions terms.
 *
 * Dispatch is best-effort by design. If it fails, the request stays queued and
 * the next dispatch, or a manual run, still drains it. A failed dispatch must
 * never fail the visitor's request, because the scan is already durably
 * recorded by the time we get here.
 *
 * One run drains a bounded number of repositories, so a large account needs
 * several. Dispatching only when a request is created meant the second run
 * never came unless another visitor happened to arrive: a hundred-and-seven
 * repository account sat at fifty-one percent for the best part of an hour
 * with the panel cheerfully reporting "51 of 107 finished". The scheduled tick
 * now dispatches too, but only when there is work actually waiting.
 */

export interface DispatchConfig {
  /** `owner/repo` holding the worker workflow. */
  readonly repository: string;
  /** Workflow file name, for example `trusted-scan-worker.yml`. */
  readonly workflowFile: string;
  /** Git ref to run. */
  readonly ref: string;
  /** Token with `actions: write` on that repository. */
  readonly token: string;
}

/**
 * Daily ceiling on runs we will start.
 *
 * A runaway loop or a burst of visitors must not spend an unbounded number of
 * Actions runs. Past this, queued work waits for a manual run rather than
 * silently consuming more of the allowance.
 */
export const MAX_DISPATCHES_PER_DAY = 200;

/**
 * Minimum gap between dispatches.
 *
 * One run drains up to 50 jobs, so several visitors arriving together are
 * served by a single run. This collapses a burst into one runner instead of
 * one runner each.
 */
export const MIN_DISPATCH_INTERVAL_MS = 60_000;

export function readDispatchConfig(environment: {
  readonly WORKER_DISPATCH_REPOSITORY?: string | undefined;
  readonly WORKER_DISPATCH_WORKFLOW?: string | undefined;
  readonly WORKER_DISPATCH_REF?: string | undefined;
  readonly WORKER_DISPATCH_TOKEN?: string | undefined;
}): DispatchConfig | null {
  const repository = environment.WORKER_DISPATCH_REPOSITORY?.trim() ?? "";
  const token = environment.WORKER_DISPATCH_TOKEN?.trim() ?? "";
  if (repository === "" || token === "") return null;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) return null;
  const workflowFile =
    environment.WORKER_DISPATCH_WORKFLOW?.trim() ?? "trusted-scan-worker.yml";
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(workflowFile)) return null;
  const ref = environment.WORKER_DISPATCH_REF?.trim() ?? "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref)) return null;
  return { repository, workflowFile, ref, token };
}

/**
 * Claims the right to dispatch, or declines.
 *
 * Both the daily cap and the interval are enforced by a single conditional
 * update, so two requests arriving at once cannot both believe they won.
 */
async function claimDispatchSlot(
  database: D1Database,
  nowMs: number,
): Promise<boolean> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  await database
    .prepare(
      `INSERT INTO worker_dispatch(utc_day, dispatches, last_dispatch_ms)
       VALUES (?, 0, 0) ON CONFLICT(utc_day) DO NOTHING`,
    )
    .bind(day)
    .run();
  const claimed = await database
    .prepare(
      `UPDATE worker_dispatch
         SET dispatches = dispatches + 1, last_dispatch_ms = ?
       WHERE utc_day = ?
         AND dispatches < ?
         AND ? - last_dispatch_ms >= ?
       RETURNING 1 AS claimed`,
    )
    .bind(
      nowMs,
      day,
      MAX_DISPATCHES_PER_DAY,
      nowMs,
      MIN_DISPATCH_INTERVAL_MS,
    )
    .first<{ claimed: number }>();
  return claimed?.claimed === 1;
}

export type DispatchOutcome =
  | "dispatched"
  | "not_configured"
  | "throttled"
  /** Nothing was claimable, so no run was started and none was wasted. */
  | "no_work"
  | "failed";

/**
 * Asks GitHub to start one worker run.
 *
 * Sends no visitor data: the workflow reads its queue from the control plane,
 * so the dispatch body carries no username, request id, or repository name.
 */
export async function dispatchScanWorker(
  database: D1Database,
  nowMs: number,
  config: DispatchConfig | null,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchOutcome> {
  if (config === null) return "not_configured";
  if (!(await claimDispatchSlot(database, nowMs))) return "throttled";
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${config.repository}/actions/workflows/${config.workflowFile}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": `${branding.productSlug}-control-plane`,
        },
        body: JSON.stringify({ ref: config.ref }),
      },
    );
    // GitHub answers 204 with no body on success.
    return response.status === 204 ? "dispatched" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * True when at least one repository could be claimed right now.
 *
 * Mirrors the claim query's own conditions, so a tick cannot spend a dispatch
 * on a queue that is empty, fully leased, or out of attempts.
 *
 * The second half exists because the first half alone stranded a scan whose
 * worker died. A run that hits its thirty minute timeout, or a runner that
 * disappears, leaves `lease_owner` set on whatever it held. Every run reaps
 * expired leases before it claims anything, so the work is perfectly
 * recoverable, but this said "no work" because none of it was unleased, so no
 * run was ever dispatched to do the reaping. The scan then sat at its
 * half-finished count until an unrelated visitor happened to start one of
 * their own, and on a quiet service that is the 24 hour abandonment timeout.
 */
export async function hasClaimableWork(
  database: D1Database,
  maxLeaseAttempts: number,
  nowMs: number,
): Promise<boolean> {
  const leased = LEASED_REPOSITORY_STATES.map(() => "?").join(", ");
  const row = await database
    .prepare(
      `SELECT 1 AS present FROM repositories
       JOIN scan_requests ON scan_requests.request_id = repositories.request_id
       WHERE scan_requests.state = 'scanning'
         AND repositories.attempt_count < ?
         AND (
           (repositories.state = 'waiting' AND repositories.lease_owner IS NULL)
           OR (
             repositories.lease_expires_at_ms IS NOT NULL
             AND repositories.lease_expires_at_ms <= ?
             AND repositories.published_lease_generation IS NULL
             AND repositories.state IN (${leased})
           )
         )
       LIMIT 1`,
    )
    .bind(maxLeaseAttempts, nowMs, ...LEASED_REPOSITORY_STATES)
    .first<{ present: number }>();
  return row !== null;
}

/** Dispatches a run only if there is something for it to do. */
export async function dispatchIfWorkWaiting(
  database: D1Database,
  nowMs: number,
  config: DispatchConfig | null,
  maxLeaseAttempts: number,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchOutcome> {
  if (config === null) return "not_configured";
  if (!(await hasClaimableWork(database, maxLeaseAttempts, nowMs))) {
    return "no_work";
  }
  return dispatchScanWorker(database, nowMs, config, fetchImpl);
}
