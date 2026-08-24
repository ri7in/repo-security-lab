import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_DISPATCHES_PER_DAY,
  MIN_DISPATCH_INTERVAL_MS,
  dispatchIfWorkWaiting,
  dispatchScanWorker,
  hasClaimableWork,
  readDispatchConfig,
} from "../src/worker-dispatch.js";

const CONFIG = {
  repository: "example-owner/example-repo",
  workflowFile: "trusted-scan-worker.yml",
  ref: "main",
  token: "token-value",
};

function accepted(): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
}

async function resetLedger(): Promise<void> {
  await env.DB.prepare("DELETE FROM worker_dispatch").run();
}

describe("dispatch configuration", () => {
  it("is disabled without a repository and token", () => {
    expect(readDispatchConfig({})).toBeNull();
    expect(
      readDispatchConfig({ WORKER_DISPATCH_REPOSITORY: "ri7in/x" }),
    ).toBeNull();
  });

  it("rejects a repository that is not owner/name", () => {
    expect(
      readDispatchConfig({
        WORKER_DISPATCH_REPOSITORY: "https://evil.test/x",
        WORKER_DISPATCH_TOKEN: "t",
      }),
    ).toBeNull();
  });

  it("rejects a workflow name that is not a yaml file", () => {
    expect(
      readDispatchConfig({
        WORKER_DISPATCH_REPOSITORY: "ri7in/x",
        WORKER_DISPATCH_TOKEN: "t",
        WORKER_DISPATCH_WORKFLOW: "../../etc/passwd",
      }),
    ).toBeNull();
  });

  it("defaults the workflow and ref", () => {
    expect(
      readDispatchConfig({
        WORKER_DISPATCH_REPOSITORY: "ri7in/x",
        WORKER_DISPATCH_TOKEN: "t",
      }),
    ).toEqual({
      repository: "ri7in/x",
      workflowFile: "trusted-scan-worker.yml",
      ref: "main",
      token: "t",
    });
  });
});

describe("on-demand dispatch", () => {
  it("does nothing when dispatch is not configured", async () => {
    await resetLedger();
    expect(await dispatchScanWorker(env.DB, 1_000, null, accepted())).toBe(
      "not_configured",
    );
  });

  it("starts one run and sends no visitor data", async () => {
    await resetLedger();
    const fetchMock = accepted();
    expect(
      await dispatchScanWorker(env.DB, 1_000_000, CONFIG, fetchMock),
    ).toBe("dispatched");
    const calls = vi.mocked(fetchMock).mock.calls;
    const [url, init] = calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/example-owner/example-repo/actions/workflows/trusted-scan-worker.yml/dispatches",
    );
    const body = init?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({ ref: "main" });
  });

  it("collapses a burst into a single run", async () => {
    await resetLedger();
    const fetchMock = accepted();
    const now = 5_000_000;
    expect(await dispatchScanWorker(env.DB, now, CONFIG, fetchMock)).toBe(
      "dispatched",
    );
    expect(await dispatchScanWorker(env.DB, now + 1_000, CONFIG, fetchMock)).toBe(
      "throttled",
    );
    expect(
      await dispatchScanWorker(env.DB, now + 5_000, CONFIG, fetchMock),
    ).toBe("throttled");
  });

  it("allows another run once the interval has passed", async () => {
    await resetLedger();
    const fetchMock = accepted();
    const now = 9_000_000;
    await dispatchScanWorker(env.DB, now, CONFIG, fetchMock);
    expect(
      await dispatchScanWorker(
        env.DB,
        now + MIN_DISPATCH_INTERVAL_MS,
        CONFIG,
        fetchMock,
      ),
    ).toBe("dispatched");
  });

  it("stops at the daily ceiling", async () => {
    await resetLedger();
    const day = new Date(1_000_000).toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO worker_dispatch(utc_day, dispatches, last_dispatch_ms)
       VALUES (?, ?, 0)`,
    )
      .bind(day, MAX_DISPATCHES_PER_DAY)
      .run();
    expect(
      await dispatchScanWorker(env.DB, 1_000_000, CONFIG, accepted()),
    ).toBe("throttled");
  });

  it("reports a refused dispatch instead of pretending it started", async () => {
    await resetLedger();
    const rejecting = vi.fn(() =>
      Promise.resolve(new Response("no", { status: 403 })),
    );
    expect(
      await dispatchScanWorker(env.DB, 2_000_000, CONFIG, rejecting),
    ).toBe("failed");
  });

  it("survives a network failure without throwing", async () => {
    await resetLedger();
    const dead = vi.fn((): Promise<Response> =>
      Promise.reject(new Error("unreachable")),
    );
    expect(await dispatchScanWorker(env.DB, 3_000_000, CONFIG, dead)).toBe(
      "failed",
    );
  });
});

/**
 * One run drains a bounded number of repositories, so a large account needs
 * several. Dispatching only when a request is created meant the second run
 * never came unless another visitor happened to arrive, and a hundred-and-
 * seven repository account sat at fifty-one percent for the best part of an
 * hour with the panel reporting "51 of 107 finished".
 */

async function seedQueue(options: {
  readonly repositoryState: string;
  readonly requestState: string;
  readonly attempts: number;
  readonly leaseOwner: string | null;

  /** Omitted means a live lease, far in the future. */
  readonly leaseExpiresAtMs?: number;
}): Promise<void> {
  await env.DB.prepare("DELETE FROM repositories").run();
  await env.DB.prepare("DELETE FROM request_totals").run();
  await env.DB.prepare("DELETE FROM scan_requests").run();
  await env.DB.prepare(
    `INSERT INTO scan_requests(request_id, github_account_id, username, state,
       reason, discovery_complete, ai_lane, created_at_ms, updated_at_ms)
     VALUES ('req_queue0001', 1, 'someone', ?, NULL, 1, 'ai_not_run', 1, 1)`,
  )
    .bind(options.requestState)
    .run();
  // repositories.request_id references request_totals, not scan_requests.
  await env.DB.prepare(
    "INSERT INTO request_totals(request_id) VALUES ('req_queue0001')",
  ).run();
  await env.DB.prepare(
    `INSERT INTO repositories(request_id, repository_id, name, commit_sha, state,
       reason, attempt_count, lease_owner, lease_generation, lease_expires_at_ms,
       discovered_at_ms, updated_at_ms, is_fork, specialist_reasons, coverage_json)
     VALUES ('req_queue0001', 1, 'one', ?, ?, NULL, ?, ?, 0, ?, 1, 1, 0, '{}', '{}')`,
  )
    .bind(
      "a".repeat(40),
      options.repositoryState,
      options.attempts,
      options.leaseOwner,
      options.leaseOwner === null
        ? null
        : (options.leaseExpiresAtMs ?? 9_999_999_999),
    )
    .run();
}

describe("dispatching for work already queued", () => {
  it("sees a repository that is waiting to be claimed", async () => {
    await seedQueue({
      repositoryState: "waiting",
      requestState: "scanning",
      attempts: 0,
      leaseOwner: null,
    });
    expect(await hasClaimableWork(env.DB, 3, 1_000)).toBe(true);
  });

  it("does not see work that nothing could claim", async () => {
    // Each of these is a reason the claim query would skip the row, so a tick
    // that dispatched on them would spend a run on an empty queue.
    for (const seed of [
      { repositoryState: "complete", requestState: "scanning", attempts: 0, leaseOwner: null },
      { repositoryState: "waiting", requestState: "complete", attempts: 0, leaseOwner: null },
      { repositoryState: "waiting", requestState: "scanning", attempts: 3, leaseOwner: null },
      { repositoryState: "waiting", requestState: "scanning", attempts: 0, leaseOwner: "worker_1" },
    ]) {
      await seedQueue(seed);
      expect(await hasClaimableWork(env.DB, 3, 1_000), JSON.stringify(seed)).toBe(false);
    }
  });

  it("sees work stranded behind a lease whose worker died", async () => {
    // A run that hits its thirty minute timeout, or a runner that vanishes,
    // leaves lease_owner set on whatever it held. Every run reaps expired
    // leases before claiming, so the work is recoverable, but this used to
    // answer "no work" because nothing was unleased, so no run was dispatched
    // to do the reaping. The scan then sat at its half-finished count until an
    // unrelated visitor started one of their own.
    await resetLedger();
    await seedQueue({
      repositoryState: "scanning",
      requestState: "scanning",
      attempts: 1,
      leaseOwner: "worker_that_died",
      leaseExpiresAtMs: 500,
    });
    expect(await hasClaimableWork(env.DB, 3, 1_000)).toBe(true);
  });

  it("does not see a lease that is still alive", async () => {
    await resetLedger();
    await seedQueue({
      repositoryState: "scanning",
      requestState: "scanning",
      attempts: 1,
      leaseOwner: "worker_still_working",
      leaseExpiresAtMs: 9_999,
    });
    expect(await hasClaimableWork(env.DB, 3, 1_000)).toBe(false);
  });

  it("does not see a stranded lease that has run out of attempts", async () => {
    await resetLedger();
    await seedQueue({
      repositoryState: "scanning",
      requestState: "scanning",
      attempts: 3,
      leaseOwner: "worker_that_died",
      leaseExpiresAtMs: 500,
    });
    expect(await hasClaimableWork(env.DB, 3, 1_000)).toBe(false);
  });

  it("starts a run for queued work and none for an empty queue", async () => {
    await resetLedger();
    await seedQueue({
      repositoryState: "waiting",
      requestState: "scanning",
      attempts: 0,
      leaseOwner: null,
    });
    expect(
      await dispatchIfWorkWaiting(env.DB, 9_000_000, CONFIG, 3, accepted()),
    ).toBe("dispatched");

    await resetLedger();
    await seedQueue({
      repositoryState: "complete",
      requestState: "complete",
      attempts: 0,
      leaseOwner: null,
    });
    const fetchMock = accepted();
    expect(await dispatchIfWorkWaiting(env.DB, 9_100_000, CONFIG, 3, fetchMock)).toBe(
      "no_work",
    );
    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(0);
  });

  it("stays quiet when dispatch is not configured", async () => {
    expect(await dispatchIfWorkWaiting(env.DB, 1_000, null, 3, accepted())).toBe(
      "not_configured",
    );
  });
});
