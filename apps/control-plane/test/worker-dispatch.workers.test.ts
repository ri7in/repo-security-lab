import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_DISPATCHES_PER_DAY,
  MIN_DISPATCH_INTERVAL_MS,
  dispatchScanWorker,
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
