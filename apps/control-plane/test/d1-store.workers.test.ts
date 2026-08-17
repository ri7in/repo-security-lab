import { env } from "cloudflare:workers";
import {
  SPECIALISTS,
  type BrokerDerivedFinding,
  type OpaqueId,
} from "@app/contracts";
import {
  StoreWriteReserveError,
  type LeaseRef,
  type RepositoryRecord,
  type SpecialistOutcomes,
} from "@app/core";
import { D1Store } from "@app/store-d1";
import { describe, it } from "vitest";

function completeCoverage(): SpecialistOutcomes {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [specialist, "complete"]),
  ) as SpecialistOutcomes;
}

function leaseRef(repository: RepositoryRecord): LeaseRef {
  if (repository.lease === null) throw new Error("expected active lease");
  return {
    requestId: repository.requestId,
    repositoryId: repository.repositoryId,
    workerId: repository.lease.workerId,
    generation: repository.lease.generation,
  };
}

function findings(requestId: OpaqueId, repositoryId: number): BrokerDerivedFinding[] {
  return Array.from({ length: 101 }, (_, index) => ({
    schema_version: 1 as const,
    finding_id: `fnd_${String(index).padStart(12, "0")}`,
    request_id: requestId,
    repository_id: repositoryId,
    commit_sha: "a".repeat(40),
    engine: "gitleaks" as const,
    rule_id: `rule-${String(index).padStart(3, "0")}`,
    category: "secret",
    severity: "high" as const,
    confidence: "high" as const,
    occurrence_bucket: "one" as const,
    remediation_key: "rotate-secret",
    owner_detail_ref: "detail_0000000001",
  }));
}

async function ledger(
  store: D1Store,
  requestId = "req_d1ledger0001" as OpaqueId,
  repositoryIds: readonly number[] = [1, 2],
  username = "ri7in",
  githubAccountId = 123,
): Promise<void> {
  await store.createRequest({ requestId, username, nowMs: 100 });
  await store.startDiscovery(requestId, 110);
  const result = await store.completeDiscovery({
    requestId,
    githubAccountId,
    canonicalLogin: username,
    repositories: repositoryIds.map((repositoryId) => ({
      repositoryId,
      name: `repo-${repositoryId}`,
      isFork: false,
      commitSha: "a".repeat(40),
    })),
    nowMs: 120,
  });
  if (result !== "completed") throw new Error("expected completed discovery");
}

async function advance(
  store: D1Store,
  lease: LeaseRef,
  throughWaitingToPublish = true,
): Promise<void> {
  const edges = [
    ["leased", "acquiring"],
    ["acquiring", "guarding"],
    ["guarding", "scanning"],
    ["scanning", "normalizing"],
    ["normalizing", "cleaning"],
    ...(throughWaitingToPublish
      ? ([
          ["cleaning", "uploading"],
          ["uploading", "waiting_to_publish"],
        ] as const)
      : []),
  ] as const;
  for (const [expectedState, nextState] of edges) {
    if (!(await store.transition({
      ...lease,
      expectedState,
      nextState,
      nowMs: 200,
    }))) {
      throw new Error("expected transition");
    }
  }
}

describe("D1 store in workerd", () => {
  it("installs discovery atomically, materializes totals, and enforces one active lease", async ({ expect }) => {
    const store = new D1Store(env.DB);
    await ledger(store);
    expect(await store.completeDiscovery({
      requestId: "req_d1ledger0001",
      githubAccountId: 123,
      canonicalLogin: "ri7in",
      repositories: [1, 2].map((repositoryId) => ({
        repositoryId,
        name: `repo-${repositoryId}`,
        isFork: false,
        commitSha: "a".repeat(40),
      })),
      nowMs: 130,
    })).toBe("idempotent");
    expect(await store.getRequestTotals("req_d1ledger0001")).toMatchObject({
      repositoryTotals: { waiting: 2 },
      coverageTotals: { snapshot: { waiting: 2 } },
    });
    const first = await store.claimNextForWorker({
      workerId: "worker_d1000001",
      nowMs: 140,
      leaseDurationMs: 600_000,
    });
    expect(first?.repositoryId).toBe(1);
    expect(await store.claimNextForWorker({
      workerId: "worker_d1000001",
      nowMs: 141,
      leaseDurationMs: 600_000,
    })).toBeNull();
    expect((await store.claimNextForWorker({
      workerId: "worker_d1000002",
      nowMs: 141,
      leaseDurationMs: 600_000,
    }))?.repositoryId).toBe(2);
  });

  it("publishes from the observed state and preserves exact idempotency", async ({ expect }) => {
    const store = new D1Store(env.DB);
    await ledger(store, "req_d1publish001", [7], "publish-user", 124);
    const claimed = await store.claimNextForWorker({
      workerId: "worker_d1000003",
      nowMs: 140,
      leaseDurationMs: 600_000,
    });
    if (claimed === null) throw new Error("expected claim");
    const lease = leaseRef(claimed);
    await advance(store, lease);
    const publication = {
      ...lease,
      terminalState: "complete" as const,
      reason: null,
      coverage: completeCoverage(),
      specialistReasons: {},
      findings: findings(lease.requestId, lease.repositoryId),
      nowMs: 300,
    };
    expect(await store.publish(publication)).toBe("published");
    expect(await store.publish(publication)).toBe("idempotent");
    expect(await store.publish({
      ...publication,
      coverage: { ...publication.coverage, osv: "unsupported" },
    })).toBe("idempotency_conflict");
    expect(await store.getRequest("req_d1publish001")).toMatchObject({
      state: "complete",
    });
    const firstPage = await store.listFindings({
      requestId: "req_d1publish001",
      afterFindingId: null,
      limit: 100,
    });
    expect(firstPage.findings).toHaveLength(100);
    expect(firstPage.nextFindingId).toBe("fnd_000000000099");
    expect((await store.listFindings({
      requestId: "req_d1publish001",
      afterFindingId: firstPage.nextFindingId,
      limit: 100,
    })).findings).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM finding_chunks WHERE request_id = ?",
      )
        .bind("req_d1publish001")
        .first<number>("count"),
    ).toBe(2);
  });

  it("allows a truthful failure publication from cleaning and rejects stale ABA generations", async ({ expect }) => {
    const store = new D1Store(env.DB);
    await ledger(store, "req_d1failure001", [9], "failure-user", 125);
    const first = await store.claimNextForWorker({
      workerId: "worker_d1000004",
      nowMs: 140,
      leaseDurationMs: 10,
    });
    if (first === null) throw new Error("expected claim");
    const stale = leaseRef(first);
    expect((await store.classifyExpiredLeasesForWorker(151, "worker_d1000004")).retryable).toHaveLength(1);
    expect(await store.requeueCleanedForWorker({
      requestId: stale.requestId,
      repositoryId: stale.repositoryId,
      generation: stale.generation,
      nowMs: 151,
    }, "worker_d1000004")).toBe(true);
    const second = await store.claimNextForWorker({
      workerId: "worker_d1000004",
      nowMs: 152,
      leaseDurationMs: 600_000,
    });
    if (second === null) throw new Error("expected second claim");
    const active = leaseRef(second);
    expect(active.generation).toBe(stale.generation + 1);
    await advance(store, active, false);
    const failedCoverage = Object.fromEntries(
      SPECIALISTS.map((specialist) => [
        specialist,
        specialist === "snapshot" || specialist === "archive_guard"
          ? "complete"
          : "failed",
      ]),
    ) as SpecialistOutcomes;
    expect(await store.publish({
      ...stale,
      terminalState: "failed",
      reason: "SCANNER_TIMEOUT",
      coverage: failedCoverage,
      specialistReasons: {
        gitleaks: "SCANNER_TIMEOUT",
        osv: "SCANNER_TIMEOUT",
        zizmor: "SCANNER_TIMEOUT",
        opengrep: "SCANNER_TIMEOUT",
      },
      findings: [],
      nowMs: 300,
    })).toBe("stale_lease");
    expect(await store.publish({
      ...active,
      terminalState: "failed",
      reason: "SCANNER_TIMEOUT",
      coverage: failedCoverage,
      specialistReasons: {
        gitleaks: "SCANNER_TIMEOUT",
        osv: "SCANNER_TIMEOUT",
        zizmor: "SCANNER_TIMEOUT",
        opengrep: "SCANNER_TIMEOUT",
      },
      findings: [],
      nowMs: 300,
    })).toBe("published");
  });

  it("atomically refuses discovery before crossing the free-tier write reserve", async ({ expect }) => {
    const store = new D1Store(env.DB);
    const requestId = "req_d1reserve001";
    const nowMs = 86_400_000;
    await store.createRequest({ requestId, username: "reserve-user", nowMs: 1 });
    await store.startDiscovery(requestId, 2);
    await env.DB.prepare(
      "INSERT INTO write_budget(utc_day, modeled_writes) VALUES ('1970-01-02', 39999)",
    ).run();
    await expect(store.completeDiscovery({
      requestId,
      githubAccountId: 126,
      canonicalLogin: "reserve-user",
      repositories: [{
        repositoryId: 1,
        name: "reserve-repo",
        isFork: false,
        commitSha: "a".repeat(40),
      }],
      nowMs,
    })).rejects.toBeInstanceOf(StoreWriteReserveError);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM repositories WHERE request_id = ?",
      )
        .bind(requestId)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT modeled_writes FROM write_budget WHERE utc_day = '1970-01-02'",
      ).first<number>("modeled_writes"),
    ).toBe(39_999);
  });

  it("refuses request creation atomically when base writes cannot be reserved", async ({ expect }) => {
    const store = new D1Store(env.DB);
    const requestId = "req_d1basecap001";
    await env.DB.prepare(
      "INSERT INTO write_budget(utc_day, modeled_writes) VALUES ('1970-01-03', 39999)",
    ).run();
    await expect(store.createRequest({
      requestId,
      username: "base-cap-user",
      nowMs: 2 * 86_400_000,
    })).rejects.toBeInstanceOf(StoreWriteReserveError);
    expect(await store.getRequest(requestId)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM request_totals WHERE request_id = ?",
      )
        .bind(requestId)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT modeled_writes FROM write_budget WHERE utc_day = '1970-01-03'",
      ).first<number>("modeled_writes"),
    ).toBe(39_999);
  });

  it("caps daily admission below retention cleanup throughput", async ({ expect }) => {
    const store = new D1Store(env.DB);
    await env.DB.prepare(
      "INSERT INTO daily_request_admission(utc_day, accepted_requests) VALUES ('1970-01-04', 239)",
    ).run();
    await store.createRequest({
      requestId: "req_dailycap0001",
      username: "daily-cap-one",
      nowMs: 3 * 86_400_000,
    });
    await expect(
      store.createRequest({
        requestId: "req_dailycap0002",
        username: "daily-cap-two",
        nowMs: 3 * 86_400_000 + 1,
      }),
    ).rejects.toBeInstanceOf(StoreWriteReserveError);
    expect(await store.getRequest("req_dailycap0002")).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT accepted_requests FROM daily_request_admission WHERE utc_day = '1970-01-04'",
      ).first<number>("accepted_requests"),
    ).toBe(240);
  });

  it("rolls back the whole ledger when the immutable account binding conflicts", async ({ expect }) => {
    const store = new D1Store(env.DB);
    await ledger(store, "req_d1account001", [1], "canonical-user", 700);
    const requestId = "req_d1account002";
    await store.createRequest({ requestId, username: "old-alias", nowMs: 200 });
    await store.startDiscovery(requestId, 201);
    await expect(store.completeDiscovery({
      requestId,
      githubAccountId: 700,
      canonicalLogin: "canonical-user",
      repositories: [{
        repositoryId: 2,
        name: "must-rollback",
        isFork: false,
        commitSha: "a".repeat(40),
      }],
      nowMs: 202,
    })).rejects.toThrow("discovery completion failed");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM repositories WHERE request_id = ?",
      )
        .bind(requestId)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT count(*) AS count FROM write_reservations
         WHERE request_id = ? AND stage = 'discovery'`,
      )
        .bind(requestId)
        .first<number>("count"),
    ).toBe(0);
    expect(await store.getRequest(requestId)).toMatchObject({
      state: "discovering",
      discoveryComplete: false,
    });
  });
});
