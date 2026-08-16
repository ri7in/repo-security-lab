import { env } from "cloudflare:workers";
import { D1Store } from "@app/store-d1";
import { HttpWorkerStore } from "@app/store-http";
import {
  WORKER_AUTH_HEADERS,
  WORKER_PROTOCOL_PATHS,
  deriveWorkerSecret,
  signWorkerRequest,
} from "@app/worker-protocol";
import { beforeEach, describe, it } from "vitest";
import { handleInternalRequest } from "../src/internal-api.js";

const masterSecret = "test-master-secret-that-is-at-least-32-characters";
const workerId = "worker_http00001";

async function putIdentity(
  id = workerId,
  generation = 1,
  status: "active" | "revoked" = "active",
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO worker_identities(
       worker_id, key_generation, status, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 1, 1)`,
  )
    .bind(id, generation, status)
    .run();
}

async function createLedger(): Promise<void> {
  const store = new D1Store(env.DB);
  await store.createRequest({
    requestId: "req_httpstore001",
    username: "transport-user",
    nowMs: 1,
  });
  await store.startDiscovery("req_httpstore001", 2);
  await store.completeDiscovery({
    requestId: "req_httpstore001",
    githubAccountId: 900,
    canonicalLogin: "transport-user",
    repositories: [
      {
        repositoryId: 42,
        name: "transport-repo",
        isFork: false,
        commitSha: "b".repeat(40),
      },
    ],
    nowMs: 3,
  });
}

function handlerFetch(serverNowMs: number): typeof fetch {
  return async (input, init) =>
    handleInternalRequest(
      new Request(input, init),
      { DB: env.DB, WORKER_AUTH_MASTER_SECRET: masterSecret },
      serverNowMs,
    );
}

async function client(
  generation = 1,
  id = workerId,
  serverNowMs = 1_001,
): Promise<HttpWorkerStore> {
  return new HttpWorkerStore({
    baseUrl: "http://localhost",
    workerId: id,
    keyGeneration: generation,
    workerSecret: await deriveWorkerSecret(masterSecret, id, generation),
    allowInsecureLocalhost: true,
    now: () => 1_000,
    fetchImpl: handlerFetch(serverNowMs),
  });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM finding_chunks"),
    env.DB.prepare("DELETE FROM repositories"),
    env.DB.prepare("DELETE FROM request_totals"),
    env.DB.prepare("DELETE FROM scan_requests"),
    env.DB.prepare("DELETE FROM worker_identities"),
  ]);
  await putIdentity();
  await createLedger();
});

describe("authenticated pull-worker transport", () => {
  it("round-trips the narrowed store port using only server-authoritative time", async ({ expect }) => {
    const store = await client();
    expect(await store.getRequest("req_httpstore001")).toMatchObject({
      username: "transport-user",
    });
    const claimed = await store.claimNext({
      workerId,
      nowMs: 99_999_999,
      leaseDurationMs: 600_000,
    });
    expect(claimed).toMatchObject({
      repositoryId: 42,
      lease: { workerId, expiresAtMs: 601_001 },
    });
    expect(await store.claimNext({
      workerId,
      nowMs: 99_999_999,
      leaseDurationMs: 600_000,
    })).toBeNull();
    if (claimed?.lease === null || claimed === null) throw new Error("expected lease");
    expect(await store.transition({
      requestId: claimed.requestId,
      repositoryId: claimed.repositoryId,
      workerId,
      generation: claimed.lease.generation,
      expectedState: "leased",
      nextState: "acquiring",
      nowMs: 99_999_999,
    })).toBe(true);
  });

  it("rejects body tampering, cross-worker signatures, stale timestamps, rotation, and revocation", async ({ expect }) => {
    const body = JSON.stringify({ leaseDurationMs: 600_000 });
    const secret = await deriveWorkerSecret(masterSecret, workerId, 1);
    const signature = await signWorkerRequest({
      workerSecret: secret,
      method: "POST",
      path: WORKER_PROTOCOL_PATHS.claim,
      workerId,
      timestampMs: 1_000,
      body,
    });
    const signedRequest = (overrides: {
      readonly body?: string;
      readonly worker?: string;
      readonly timestamp?: string;
      readonly signature?: string;
    } = {}) =>
      new Request(`https://control.test${WORKER_PROTOCOL_PATHS.claim}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WORKER_AUTH_HEADERS.workerId]: overrides.worker ?? workerId,
          [WORKER_AUTH_HEADERS.keyGeneration]: "1",
          [WORKER_AUTH_HEADERS.timestampMs]: overrides.timestamp ?? "1000",
          [WORKER_AUTH_HEADERS.signature]: overrides.signature ?? signature,
        },
        body: overrides.body ?? body,
      });

    expect((await handleInternalRequest(
      signedRequest({ body: JSON.stringify({ leaseDurationMs: 600_001 }) }),
      { DB: env.DB, WORKER_AUTH_MASTER_SECRET: masterSecret },
      1_001,
    )).status).toBe(403);
    expect((await handleInternalRequest(
      signedRequest({ worker: "worker_http00002" }),
      { DB: env.DB, WORKER_AUTH_MASTER_SECRET: masterSecret },
      1_001,
    )).status).toBe(403);
    expect((await handleInternalRequest(
      signedRequest({ timestamp: "999999" }),
      { DB: env.DB, WORKER_AUTH_MASTER_SECRET: masterSecret },
      1_001,
    )).status).toBe(403);

    await putIdentity(workerId, 2);
    await expect((await client()).getRequest("req_httpstore001")).rejects.toThrow(
      "AUTH_INVALID",
    );
    expect(await (await client(2)).getRequest("req_httpstore001")).not.toBeNull();
    await putIdentity(workerId, 2, "revoked");
    await expect((await client(2)).getRequest("req_httpstore001")).rejects.toThrow(
      "AUTH_INVALID",
    );
  });
});
