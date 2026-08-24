import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SPECIALISTS,
  type FailureClass,
  type OpaqueId,
  type RepositoryTerminalState,
  type SpecialistCoverageOutcome,
} from "@app/contracts";
import type {
  LeaseRef,
  PublishInput,
  RepositoryRecord,
  SpecialistOutcomes,
} from "@app/core";
import { aggregateLedger } from "@app/core";
import {
  CLAIM_NEXT_SQL,
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  SqliteStore,
} from "@app/store-sqlite";

const LEGACY_SPECIALISTS = [
  "snapshot",
  "archive_guard",
  "gitleaks",
  "osv",
  "zizmor",
  "opengrep",
] as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "repo-security-store-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "store.sqlite");
}

function discoveryInput(
  repositoryIds: readonly number[],
  requestId = "req_0000000001" as OpaqueId,
) {
  return {
    requestId,
    githubAccountId: 123,
    canonicalLogin: "ri7in",
    repositories: repositoryIds.map((repositoryId) => ({
      repositoryId,
      name: `repo-${repositoryId}`,
      isFork: false,
      commitSha: "a".repeat(40),
    })),
    nowMs: 1_000,
  } as const;
}

async function createLedger(
  store: SqliteStore,
  repositoryIds: readonly number[],
  requestId = "req_0000000001" as OpaqueId,
) {
  await store.createRequest({
    requestId,
    username: "ri7in",
    nowMs: 900,
  });
  expect(await store.startDiscovery(requestId, 950)).toBe(true);
  expect(
    await store.completeDiscovery(discoveryInput(repositoryIds, requestId)),
  ).toBe("completed");
  const completed = await store.getRequest(requestId);
  if (completed === null) throw new Error("test expected request");
  return completed;
}

async function expectMaterializedTotals(
  store: SqliteStore,
  requestId = "req_0000000001" as OpaqueId,
): Promise<void> {
  const request = await store.getRequest(requestId);
  if (request === null) throw new Error("test expected request");
  const repositories = (
    await store.listRepositories({
      requestId,
      afterRepositoryId: null,
      limit: 100,
    })
  ).repositories;
  const aggregate = aggregateLedger(request, repositories);
  expect(await store.getRequestTotals(requestId)).toEqual({
    repositoryTotals: aggregate.repositoryTotals,
    coverageTotals: aggregate.coverageTotals,
  });
}

function outcomes(
  outcome: SpecialistCoverageOutcome = "complete",
): SpecialistOutcomes {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [specialist, outcome]),
  ) as SpecialistOutcomes;
}

function leaseRef(repository: RepositoryRecord): LeaseRef {
  if (repository.lease === null) {
    throw new Error("test expected a lease");
  }
  return {
    requestId: repository.requestId,
    repositoryId: repository.repositoryId,
    workerId: repository.lease.workerId,
    generation: repository.lease.generation,
  };
}

async function advanceToWaitingToPublish(
  store: SqliteStore,
  repository: RepositoryRecord,
  nowMs: number,
): Promise<LeaseRef> {
  const lease = leaseRef(repository);
  const edges = [
    ["leased", "acquiring"],
    ["acquiring", "guarding"],
    ["guarding", "scanning"],
    ["scanning", "normalizing"],
    ["normalizing", "cleaning"],
    ["cleaning", "uploading"],
    ["uploading", "waiting_to_publish"],
  ] as const;
  for (const [expectedState, nextState] of edges) {
    expect(
      await store.transition({
        ...lease,
        expectedState,
        nextState,
        nowMs,
      }),
    ).toBe(true);
  }
  return lease;
}

function publication(
  lease: LeaseRef,
  terminalState: Exclude<RepositoryTerminalState, "empty"> = "complete",
  reason: FailureClass | null = null,
): PublishInput {
  if (terminalState === "complete") {
    return {
      ...lease,
      terminalState,
      reason: null,
      coverage: outcomes(),
      specialistReasons: {},
      findings: [],
      nowMs: 1_500,
    };
  }
  if (terminalState === "partial") {
    // A partly scanned repository may publish with no reason: the per-engine
    // entry carries the truth, and the worker used to invent FINDING_LIMIT.
    return {
      ...lease,
      terminalState: "partial",
      reason,
      coverage: outcomes(),
      specialistReasons: {},
      findings: [],
      nowMs: 1_500,
    };
  }
  if (reason === null) {
    throw new Error("test requires a failure reason");
  }
  return {
    ...lease,
    terminalState,
    reason,
    coverage: outcomes(),
    specialistReasons: {},
    findings: [],
    nowMs: 1_500,
  };
}

describe("SQLite store ledger", () => {
  it("keeps O(1) materialized totals exact across lease and publication states", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1, 2]);
    await expectMaterializedTotals(store);
    const claimed = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 1_000,
    });
    if (claimed === null) throw new Error("test expected claim");
    await expectMaterializedTotals(store);
    const lease = await advanceToWaitingToPublish(store, claimed, 1_200);
    await expectMaterializedTotals(store);
    expect(await store.publish(publication(lease))).toBe("published");
    await expectMaterializedTotals(store);
    expect(await store.getRequestTotals("missing_request")).toBeNull();
    store.close();
  });

  it("lists accepted and interrupted-discovery rows for startup recovery", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await store.createRequest({
      requestId: "req_pending00001",
      username: "ri7in",
      nowMs: 200,
    });
    await store.createRequest({
      requestId: "req_pending00002",
      username: "other-user",
      nowMs: 100,
    });
    expect(await store.startDiscovery("req_pending00002", 150)).toBe(true);
    await store.createRequest({
      requestId: "req_terminal0001",
      username: "third-user",
      nowMs: 50,
    });
    expect(
      await store.failRequest({
        requestId: "req_terminal0001",
        reason: "GITHUB_NOT_FOUND",
        nowMs: 60,
      }),
    ).toBe(true);

    expect(
      (await store.listPendingDiscoveryRequests(100)).map(
        (request) => [request.requestId, request.state],
      ),
    ).toEqual([
      ["req_pending00002", "discovering"],
      ["req_pending00001", "accepted"],
    ]);
    expect(
      (await store.listPendingDiscoveryRequests(1))[0]?.requestId,
    ).toBe("req_pending00002");
    await expect(store.listPendingDiscoveryRequests(0)).rejects.toThrow(
      "invalid pending-discovery limit",
    );
    store.close();
  });

  it("persists accepted before discovery and completes discovery idempotently", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const accepted = await store.createRequest({
      requestId: "req_0000000001",
      username: "ri7in",
      nowMs: 100,
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.githubAccountId).toBeNull();
    expect(accepted.discoveryComplete).toBe(false);
    expect(await store.startDiscovery(accepted.requestId, 110)).toBe(true);
    expect((await store.getRequest(accepted.requestId))?.state).toBe("discovering");

    const discovery = discoveryInput([1, 2]);
    expect(await store.completeDiscovery(discovery)).toBe("completed");
    expect((await store.getRequest(accepted.requestId))?.githubAccountId).toBe(123);
    expect(await store.completeDiscovery(discovery)).toBe("idempotent");
    expect(
      await store.completeDiscovery({
        ...discovery,
        githubAccountId: 124,
      }),
    ).toBe("conflict");
    expect(
      await store.completeDiscovery({
        ...discovery,
        canonicalLogin: "renamed-user",
      }),
    ).toBe("conflict");
    expect(
      await store.completeDiscovery({
        ...discovery,
        repositories: discovery.repositories.map((repository, index) =>
          index === 0 ? { ...repository, isFork: !repository.isFork } : repository,
        ),
      }),
    ).toBe("conflict");
    expect(
      await store.completeDiscovery({
        ...discovery,
        repositories: [
          ...discovery.repositories,
          { repositoryId: 3, name: "repo-3", isFork: true, commitSha: "b".repeat(40) },
        ],
      }),
    ).toBe("conflict");
    store.close();
  });

  it("records a fixed request-level discovery failure", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const accepted = await store.createRequest({
      requestId: "req_0000000001",
      username: "ri7in",
      nowMs: 100,
    });
    expect(
      await store.failRequest({
        requestId: accepted.requestId,
        reason: "GITHUB_RATE_LIMIT",
        nowMs: 120,
      }),
    ).toBe(true);
    const failed = await store.getRequest(accepted.requestId);
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toBe("GITHUB_RATE_LIMIT");
    expect(await store.startDiscovery(accepted.requestId, 130)).toBe(false);
    expect(await store.completeDiscovery(discoveryInput([1]))).toBe(
      "invalid_state",
    );
    store.close();
  });

  it("atomically prevents case-insensitive duplicate active usernames", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await store.createRequest({
      requestId: "req_0000000001",
      username: "ri7in",
      nowMs: 100,
    });
    await expect(
      store.createRequest({
        requestId: "req_0000000002",
        username: "RI7IN",
        nowMs: 101,
      }),
    ).rejects.toThrow("request creation failed");
    expect((await store.findActiveRequestByUsername("RI7IN"))?.requestId).toBe(
      "req_0000000001",
    );
    await store.failRequest({
      requestId: "req_0000000001",
      reason: "CANCELLED",
      nowMs: 102,
    });
    expect(
      (
        await store.createRequest({
          requestId: "req_0000000002",
          username: "RI7IN",
          nowMs: 103,
        })
      ).requestId,
    ).toBe("req_0000000002");
    store.close();
  });

  it("creates the complete ledger atomically and persists it across reopen", async () => {
    const filename = databasePath();
    const first = new SqliteStore({ filename, migrationTimeMs: 100 });
    const created = await createLedger(first, [3, 1, 2]);
    expect(created.state).toBe("scanning");
    expect(created.discoveryComplete).toBe(true);
    expect(
      (await first.listRepositories({
        requestId: created.requestId,
        afterRepositoryId: null,
        limit: 100,
      })).repositories.map((repository) => repository.repositoryId),
    ).toEqual([1, 2, 3]);
    first.close();

    const reopened = new SqliteStore({ filename, migrationTimeMs: 200 });
    expect((await reopened.getRequest(created.requestId))?.state).toBe("scanning");
    expect(
      (await reopened.listRepositories({
        requestId: created.requestId,
        afterRepositoryId: null,
        limit: 100,
      })).repositories,
    ).toHaveLength(3);
    reopened.close();
  });

  it("upgrades a version-one database before persisting fork identity", async () => {
    const filename = databasePath();
    const legacy = new Database(filename);
    legacy.exec(MIGRATION_001);
    legacy
      .prepare(
        "INSERT INTO schema_migrations(version, applied_at_ms) VALUES (1, 1)",
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO scan_requests(
          request_id, github_account_id, username, state, reason,
          discovery_complete, ai_lane, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'scanning', NULL, 1, 'ai_not_run', 1, 1)`,
      )
      .run("req_legacy0001", 999, "old-login");
    legacy
      .prepare(
        `INSERT INTO repositories(
          request_id, repository_id, name, commit_sha, state, reason,
          attempt_count, lease_owner, lease_generation, lease_expires_at_ms,
          published_lease_generation, discovered_at_ms, updated_at_ms
        ) VALUES (?, 99, 'legacy-repo', ?, 'waiting', NULL, 0, NULL, 0, NULL, NULL, 1, 1)`,
      )
      .run("req_legacy0001", "b".repeat(40));
    const insertLegacyCoverage = legacy.prepare(
      `INSERT INTO repository_coverage(
        request_id, repository_id, specialist, progress_state
      ) VALUES ('req_legacy0001', 99, ?, 'waiting')`,
    );
    // The specialists that existed at this schema version, spelled out on
    // purpose: a legacy fixture must not follow today's list, or adding an
    // engine breaks a test about databases written before it existed.
    for (const specialist of LEGACY_SPECIALISTS) {
      insertLegacyCoverage.run(specialist);
    }
    legacy.close();

    const store = new SqliteStore({ filename, migrationTimeMs: 2 });
    expect((await store.getRequest("req_legacy0001"))?.githubAccountId).toBe(999);
    expect(
      (
        await store.listRepositories({
          requestId: "req_legacy0001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({ repositoryId: 99, isFork: false });
    await store.createRequest({
      requestId: "req_0000000001",
      username: "ri7in",
      nowMs: 10,
    });
    expect(
      await store.completeDiscovery({
        ...discoveryInput([1]),
        repositories: [
          {
            repositoryId: 1,
            name: "forked",
            isFork: true,
            commitSha: "a".repeat(40),
          },
        ],
      }),
    ).toBe("completed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0]?.isFork,
    ).toBe(true);
    store.close();

    const migrated = new Database(filename);
    migrated.pragma("foreign_keys = ON");
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.prepare("DELETE FROM scan_requests WHERE request_id = ?").run(
      "req_legacy0001",
    );
    expect(
      migrated
        .prepare("SELECT count(*) AS count FROM repositories WHERE request_id = ?")
        .get("req_legacy0001"),
    ).toEqual({ count: 0 });
    migrated.close();
  });

  it("upgrades a populated version-four ledger without losing lease or publication state", async () => {
    const filename = databasePath();
    const legacy = new Database(filename);
    legacy.exec(MIGRATION_001);
    legacy
      .prepare("INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, 1)")
      .run(1);
    legacy.exec(MIGRATION_002);
    legacy
      .prepare("INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, 1)")
      .run(2);
    legacy.exec(MIGRATION_003);
    legacy
      .prepare("INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, 1)")
      .run(3);
    legacy.exec(MIGRATION_004);
    legacy
      .prepare("INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, 1)")
      .run(4);
    const insertRequest = legacy.prepare(
      `INSERT INTO scan_requests(
        request_id, github_account_id, username, state, reason,
        discovery_complete, ai_lane, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, NULL, 1, 'ai_not_run', 1, 1)`,
    );
    insertRequest.run("req_v4active001", 123, "ri7in", "scanning");
    insertRequest.run("req_v4terminal1", 456, "finished-user", "complete");
    const insertRepository = legacy.prepare(
      `INSERT INTO repositories(
        request_id, repository_id, name, commit_sha, state, reason,
        attempt_count, lease_owner, lease_generation, lease_expires_at_ms,
        published_lease_generation, discovered_at_ms, updated_at_ms, is_fork
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, 1, 0)`,
    );
    insertRepository.run(
      "req_v4active001", 10, "waiting-repo", "a".repeat(40), "waiting",
      0, null, 0, null, null,
    );
    insertRepository.run(
      "req_v4active001", 11, "leased-repo", "b".repeat(40), "leased",
      1, "worker_legacy01", 1, 5_000, null,
    );
    insertRepository.run(
      "req_v4terminal1", 12, "published-repo", "c".repeat(40), "complete",
      1, null, 1, null, 1,
    );
    const insertCoverage = legacy.prepare(
      `INSERT INTO repository_coverage(
        request_id, repository_id, specialist, progress_state
      ) VALUES (?, ?, ?, ?)`,
    );
    for (const [requestId, repositoryId, progress] of [
      ["req_v4active001", 10, "waiting"],
      ["req_v4active001", 11, "waiting"],
      ["req_v4terminal1", 12, "complete"],
    ] as const) {
      // Version-four fixture: the specialists that existed then, not today's.
      for (const specialist of LEGACY_SPECIALISTS) {
        insertCoverage.run(requestId, repositoryId, specialist, progress);
      }
    }
    legacy
      .prepare(
        `INSERT INTO findings(
          finding_id, request_id, repository_id, commit_sha, engine, rule_id,
          category, severity, confidence, occurrence_bucket, remediation_key,
          owner_detail_ref
        ) VALUES (
          'fnd_v4legacy001', 'req_v4terminal1', 12, ?, 'gitleaks',
          'github-pat', 'secret', 'high', 'high', 'one', 'rotate-secret',
          'detail_v4legacy'
        )`,
      )
      .run("c".repeat(40));
    legacy.close();

    const store = new SqliteStore({ filename, migrationTimeMs: 2 });
    expect(await store.getRequest("req_v4active001")).toMatchObject({
      state: "scanning",
      githubAccountId: 123,
    });
    const active = await store.listRepositories({
      requestId: "req_v4active001",
      afterRepositoryId: null,
      limit: 10,
    });
    expect(active.repositories[1]).toMatchObject({
      state: "leased",
      attemptCount: 1,
      leaseGeneration: 1,
    });
    expect(
      (
        await store.listRepositories({
          requestId: "req_v4terminal1",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "complete",
      publishedLeaseGeneration: 1,
      // A version-four database was written before the AI engine existed, so
      // that engine has no recorded outcome and correctly reads as waiting.
      // Back-filling it with "complete" would claim a review that never ran.
      coverage: { ...outcomes(), ai: "waiting" },
    });
    expect(
      await store.listFindings({
        requestId: "req_v4terminal1",
        afterFindingId: null,
        limit: 10,
      }),
    ).toMatchObject({ findings: [{ finding_id: "fnd_v4legacy001" }] });
    await expect(
      store.createRequest({
        requestId: "req_v5duplicate1",
        username: "RI7IN",
        nowMs: 3,
      }),
    ).rejects.toThrow("request creation failed");
    expect(
      await store.claimNext({
        workerId: "worker_v5claim01",
        nowMs: 2_000,
        leaseDurationMs: 1_000,
      }),
    ).toMatchObject({ repositoryId: 10, attemptCount: 1, leaseGeneration: 1 });
    store.close();

    const migrated = new Database(filename);
    migrated.pragma("foreign_keys = ON");
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(
      migrated
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((version) => ({ version })));
    migrated.close();
  });

  it("records zero-repository and no-default-branch accounts without omission", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const emptyAccount = await createLedger(store, []);
    expect(emptyAccount.state).toBe("complete");

    await store.createRequest({
      requestId: "req_0000000002",
      username: "ri7in",
      nowMs: 900,
    });
    const noBranchResult = await store.completeDiscovery({
      ...discoveryInput([], "req_0000000002"),
      repositories: [{ repositoryId: 77, name: "blank", isFork: false, commitSha: null }],
    });
    expect(noBranchResult).toBe("completed");
    const noBranch = await store.getRequest("req_0000000002");
    if (noBranch === null) throw new Error("test expected request");
    expect(noBranch.state).toBe("complete");
    const page = await store.listRepositories({
      requestId: noBranch.requestId,
      afterRepositoryId: null,
      limit: 10,
    });
    expect(page.repositories[0]?.state).toBe("empty");
    expect(new Set(Object.values(page.repositories[0]?.coverage ?? {}))).toEqual(
      new Set(["not_applicable"]),
    );
    store.close();
  });

  it("leaves the durable request untouched when a discovery ledger is invalid", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await store.createRequest({
      requestId: "req_0000000001",
      username: "ri7in",
      nowMs: 900,
    });
    const duplicate = {
      ...discoveryInput([1]),
      repositories: [
        { repositoryId: 1, name: "one", isFork: false, commitSha: "a".repeat(40) },
        { repositoryId: 1, name: "duplicate", isFork: false, commitSha: "b".repeat(40) },
      ],
    };
    await expect(store.completeDiscovery(duplicate)).rejects.toThrow(
      "invalid repository ledger input",
    );
    expect((await store.getRequest(duplicate.requestId))?.state).toBe("accepted");
    expect(
      (await store.listRepositories({
        requestId: duplicate.requestId,
        afterRepositoryId: null,
        limit: 10,
      })).repositories,
    ).toEqual([]);
    store.close();
  });

  it("persists the deep-read slot mark and hands it to the claiming worker", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const requestId = "req_0000000001" as OpaqueId;
    await store.createRequest({ requestId, username: "ri7in", nowMs: 900 });
    expect(await store.startDiscovery(requestId, 950)).toBe(true);
    expect(
      await store.completeDiscovery({
        ...discoveryInput([1, 2], requestId),
        repositories: [
          {
            repositoryId: 1,
            name: "old-project",
            isFork: false,
            commitSha: "a".repeat(40),
            aiEligible: false,
          },
          {
            repositoryId: 2,
            name: "active-project",
            isFork: false,
            commitSha: "b".repeat(40),
            aiEligible: true,
          },
        ],
      }),
    ).toBe("completed");
    const page = await store.listRepositories({
      requestId,
      afterRepositoryId: null,
      limit: 10,
    });
    expect(page.repositories.map((row) => row.aiEligible)).toEqual([false, true]);
    const claimed = await store.claimNext({
      workerId: "wrk_0000000001",
      nowMs: 1_100,
      leaseDurationMs: 60_000,
    });
    expect(claimed).toMatchObject({ repositoryId: 1, aiEligible: false });
    store.close();
  });

  it("stores no deep-read mark for a ledger written without one", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const created = await createLedger(store, [7]);
    const page = await store.listRepositories({
      requestId: created.requestId,
      afterRepositoryId: null,
      limit: 10,
    });
    // Null, not false: a pre-mark row must keep meaning "chosen the old way".
    expect(page.repositories[0]?.aiEligible).toBeNull();
    store.close();
  });

  it("paginates by immutable repository id without duplicates", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const created = await createLedger(store, [5, 2, 9]);
    const first = await store.listRepositories({
      requestId: created.requestId,
      afterRepositoryId: null,
      limit: 2,
    });
    expect(first.repositories.map((repository) => repository.repositoryId)).toEqual([2, 5]);
    expect(first.nextRepositoryId).toBe(5);
    const second = await store.listRepositories({
      requestId: created.requestId,
      afterRepositoryId: first.nextRepositoryId,
      limit: 2,
    });
    expect(second.repositories.map((repository) => repository.repositoryId)).toEqual([9]);
    expect(second.nextRepositoryId).toBeNull();
    store.close();
  });
});

describe("SQLite store leases", () => {
  it("holds an exclusive runtime lock while preserving shared-mode tests", () => {
    const filename = databasePath();
    const first = new SqliteStore({ filename, migrationTimeMs: 1, exclusive: true });
    expect(
      () => new SqliteStore({ filename, migrationTimeMs: 1, exclusive: true }),
    ).toThrow("store initialization failed");
    first.close();
    const reopened = new SqliteStore({
      filename,
      migrationTimeMs: 1,
      exclusive: true,
    });
    reopened.close();
  });

  it("atomically gives two independent connections different jobs", async () => {
    const filename = databasePath();
    const setup = new SqliteStore({ filename, migrationTimeMs: 1 });
    await createLedger(setup, [10, 20]);
    const first = new SqliteStore({ filename, migrationTimeMs: 1 });
    const second = new SqliteStore({ filename, migrationTimeMs: 1 });
    const [left, right] = await Promise.all([
      first.claimNext({ workerId: "worker_00000001", nowMs: 1_100, leaseDurationMs: 500 }),
      second.claimNext({ workerId: "worker_00000002", nowMs: 1_100, leaseDurationMs: 500 }),
    ]);
    expect(new Set([left?.repositoryId, right?.repositoryId])).toEqual(
      new Set([10, 20]),
    );
    first.close();
    second.close();
    setup.close();
  });

  it("survives a true worker-thread race on the exact claim statement", async () => {
    const filename = databasePath();
    const setup = new SqliteStore({ filename, migrationTimeMs: 1 });
    await createLedger(setup, [10, 20]);
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const barrier = new Int32Array(gate);

    const runWorker = (workerId: string): Promise<number | null> =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./claim-worker.mjs", import.meta.url), {
          workerData: {
            filename,
            workerId,
            nowMs: 1_100,
            expiresAtMs: 1_600,
            sql: CLAIM_NEXT_SQL,
            gate,
          },
        });
        worker.once("message", (message: { repositoryId?: number | null; error?: string }) => {
          if (message.error !== undefined) {
            reject(new Error(message.error));
          } else {
            resolve(message.repositoryId ?? null);
          }
        });
        worker.once("error", reject);
      });

    const claims = [runWorker("worker_00000001"), runWorker("worker_00000002")];
    while (Atomics.load(barrier, 0) < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, 2);
    expect(new Set(await Promise.all(claims))).toEqual(new Set([10, 20]));
    setup.close();
  });

  it("rejects expired, wrong-owner, and stale-generation mutations", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    const first = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 100,
    });
    expect(first?.lease?.generation).toBe(1);
    if (first === null || first.lease === null) throw new Error("test expected lease");
    expect(
      await store.heartbeat({
        ...leaseRef(first),
        nowMs: 1_200,
        leaseDurationMs: 100,
      }),
    ).toBe(false);
    expect(await store.classifyExpiredLeases(1_200)).toEqual({
      retryable: [
        {
          requestId: first.requestId,
          repositoryId: first.repositoryId,
          generation: first.leaseGeneration,
        },
      ],
      exhausted: [],
    });
    expect(
      await store.claimNext({
        workerId: "worker_00000002",
        nowMs: 1_201,
        leaseDurationMs: 500,
      }),
    ).toBeNull();
    expect(
      await store.requeueCleaned({
        requestId: first.requestId,
        repositoryId: first.repositoryId,
        generation: first.leaseGeneration + 1,
        nowMs: 1_201,
      }),
    ).toBe(false);
    expect(
      await store.requeueCleaned({
        requestId: first.requestId,
        repositoryId: first.repositoryId,
        generation: first.leaseGeneration,
        nowMs: 1_201,
      }),
    ).toBe(true);
    const second = await store.claimNext({
      workerId: "worker_00000002",
      nowMs: 1_202,
      leaseDurationMs: 500,
    });
    expect(second?.lease?.generation).toBe(2);
    if (second === null || second.lease === null) throw new Error("test expected lease");
    expect(
      await store.transition({
        ...leaseRef(first),
        expectedState: "leased",
        nextState: "acquiring",
        nowMs: 1_203,
      }),
    ).toBe(false);
    expect(
      await store.transition({
        ...leaseRef(second),
        workerId: "worker_00000003",
        expectedState: "leased",
        nextState: "acquiring",
        nowMs: 1_203,
      }),
    ).toBe(false);
    expect(
      await store.transition({
        ...leaseRef(second),
        expectedState: "leased",
        nextState: "acquiring",
        nowMs: 1_203,
      }),
    ).toBe(true);
    store.close();
  });

  it("voluntarily releases without resetting the ABA generation", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    const first = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 500,
    });
    if (first === null) throw new Error("test expected claim");
    expect(await store.release({ ...leaseRef(first), nowMs: 1_200 })).toBe(true);
    const waiting = (
      await store.listRepositories({
        requestId: first.requestId,
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(waiting?.lease).toBeNull();
    expect(waiting?.leaseGeneration).toBe(1);

    const second = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_201,
      leaseDurationMs: 500,
    });
    expect(second?.leaseGeneration).toBe(2);
    expect(second?.lease?.generation).toBe(2);
    if (second === null) throw new Error("test expected claim");
    expect(await store.release({ ...leaseRef(first), nowMs: 1_202 })).toBe(false);
    store.close();
  });

  it("does not directly release a source-bearing pipeline state", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    const claim = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 500,
    });
    if (claim === null) throw new Error("test expected claim");
    expect(
      await store.transition({
        ...leaseRef(claim),
        expectedState: "leased",
        nextState: "acquiring",
        nowMs: 1_101,
      }),
    ).toBe(true);
    expect(await store.release({ ...leaseRef(claim), nowMs: 1_102 })).toBe(false);
    store.close();
  });

  it("requeues only the exact live cleaned lease and rejects expired or published rows", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    const first = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 100,
    });
    if (first === null) throw new Error("test expected claim");
    expect(await store.retryCleaned({ ...leaseRef(first), nowMs: 1_101 })).toBe(false);
    expect(
      await store.transition({
        ...leaseRef(first),
        expectedState: "leased",
        nextState: "acquiring",
        nowMs: 1_102,
      }),
    ).toBe(true);
    expect(
      await store.transition({
        ...leaseRef(first),
        expectedState: "acquiring",
        nextState: "cleaning",
        nowMs: 1_103,
      }),
    ).toBe(true);
    expect(
      await store.retryCleaned({
        ...leaseRef(first),
        generation: first.leaseGeneration + 1,
        nowMs: 1_104,
      }),
    ).toBe(false);
    expect(
      await store.retryCleaned({
        ...leaseRef(first),
        workerId: "worker_00000002",
        nowMs: 1_104,
      }),
    ).toBe(false);
    expect(await store.retryCleaned({ ...leaseRef(first), nowMs: 1_200 })).toBe(false);
    expect(await store.classifyExpiredLeases(1_200)).toMatchObject({
      retryable: [{ generation: 1 }],
    });
    expect(
      await store.requeueCleaned({
        requestId: first.requestId,
        repositoryId: first.repositoryId,
        generation: first.leaseGeneration,
        nowMs: 1_200,
      }),
    ).toBe(true);

    const second = await store.claimNext({
      workerId: "worker_00000002",
      nowMs: 1_201,
      leaseDurationMs: 1_000,
    });
    if (second === null) throw new Error("test expected second claim");
    const publishLease = await advanceToWaitingToPublish(store, second, 1_202);
    expect(await store.publish(publication(publishLease))).toBe("published");
    expect(await store.retryCleaned({ ...leaseRef(second), nowMs: 1_203 })).toBe(false);
    store.close();
  });

  it("refuses a live cleaned retry at the attempt ceiling", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await store.claimNext({
        workerId: `worker_0000000${attempt}`,
        nowMs: 1_000 + attempt * 10,
        leaseDurationMs: 1_000,
      });
      if (claim === null) throw new Error("test expected claim");
      const lease = leaseRef(claim);
      expect(
        await store.transition({
          ...lease,
          expectedState: "leased",
          nextState: "acquiring",
          nowMs: 1_001 + attempt * 10,
        }),
      ).toBe(true);
      expect(
        await store.transition({
          ...lease,
          expectedState: "acquiring",
          nextState: "cleaning",
          nowMs: 1_002 + attempt * 10,
        }),
      ).toBe(true);
      expect(
        await store.retryCleaned({ ...lease, nowMs: 1_003 + attempt * 10 }),
      ).toBe(attempt < 3);
    }
    const parked = (
      await store.listRepositories({
        requestId: "req_0000000001",
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(parked).toMatchObject({ state: "cleaning", attemptCount: 3 });
    store.close();
  });

  it("does not let release bypass janitor cleanup at the attempt ceiling", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await store.claimNext({
        workerId: `worker_0000000${attempt}`,
        nowMs: 1_000 + attempt * 100,
        leaseDurationMs: 100,
      });
      if (claim === null) throw new Error("test expected claim");
      expect(
        await store.release({
          ...leaseRef(claim),
          nowMs: 1_000 + attempt * 100 + 10,
        }),
      ).toBe(attempt < 3);
    }
    const parked = (
      await store.listRepositories({
        requestId: "req_0000000001",
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(parked?.state).toBe("leased");
    expect(parked?.leaseGeneration).toBe(3);
    store.close();
  });

  it("parks exhaustion until the exact cleaned generation is finalized", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const created = await createLedger(store, [1]);
    let exhausted:
      | { requestId: OpaqueId; repositoryId: number; generation: number }
      | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await store.claimNext({
        workerId: `worker_0000000${attempt}`,
        nowMs: 1_000 + attempt * 100,
        leaseDurationMs: 50,
      });
      if (claim === null) throw new Error("test expected claim");
      expect(claim.leaseGeneration).toBe(attempt);
      const result = await store.classifyExpiredLeases(
        1_000 + attempt * 100 + 50,
      );
      if (attempt < 3) {
        expect(result).toEqual({
          retryable: [
            {
              requestId: claim.requestId,
              repositoryId: claim.repositoryId,
              generation: claim.leaseGeneration,
            },
          ],
          exhausted: [],
        });
        expect(
          await store.requeueCleaned({
            requestId: claim.requestId,
            repositoryId: claim.repositoryId,
            generation: claim.leaseGeneration,
            nowMs: 1_000 + attempt * 100 + 50,
          }),
        ).toBe(true);
      } else {
        expect(result.retryable).toEqual([]);
        expect(result.exhausted).toHaveLength(1);
        exhausted = result.exhausted[0];
      }
    }
    const parked = (
      await store.listRepositories({
        requestId: created.requestId,
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(parked?.state).toBe("leased");
    expect(parked?.reason).toBeNull();
    expect((await store.getRequest(created.requestId))?.state).toBe("scanning");
    if (exhausted === undefined) throw new Error("test expected exhaustion");
    expect(
      await store.finalizeExhausted({
        ...exhausted,
        generation: exhausted.generation - 1,
        nowMs: 1_400,
      }),
    ).toBe(false);

    // The production caller performs generation-keyed scratch cleanup before
    // this CAS finalization. This store test proves the exact-generation gate.
    expect(
      await store.finalizeExhausted({ ...exhausted, nowMs: 1_400 }),
    ).toBe(true);
    const terminal = (
      await store.listRepositories({
        requestId: created.requestId,
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(terminal?.state).toBe("failed");
    expect(terminal?.reason).toBe("LEASE_RETRY_EXHAUSTED");
    expect(terminal?.leaseGeneration).toBe(3);
    expect(new Set(Object.values(terminal?.coverage ?? {}))).toEqual(
      new Set(["failed"]),
    );
    expect((await store.getRequest(created.requestId))?.state).toBe("complete");
    expect(
      await store.claimNext({
        workerId: "worker_00000009",
        nowMs: 2_000,
        leaseDurationMs: 100,
      }),
    ).toBeNull();
    store.close();
  });
});

describe("SQLite store publication", () => {
  it("rejects terminal metadata that contradicts coverage or findings", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    const claimed = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 1_000,
    });
    if (claimed === null) throw new Error("test expected claim");
    const lease = await advanceToWaitingToPublish(store, claimed, 1_200);
    await expect(
      store.publish({
        ...publication(lease),
        coverage: { ...outcomes(), gitleaks: "partial" },
      }),
    ).rejects.toThrow("invalid publication metadata");
    await expect(
      store.publish(publication(lease, "failed", "SCANNER_INTERNAL")),
    ).rejects.toThrow("invalid publication metadata");
    expect(await store.publish(publication(lease))).toBe("published");
    store.close();
  });

  it("persists engine-scoped failure while retaining surviving evidence", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    const claimed = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 1_000,
    });
    if (claimed === null) throw new Error("test expected claim");
    const lease = await advanceToWaitingToPublish(store, claimed, 1_200);
    const input: PublishInput = {
      ...lease,
      terminalState: "partial",
      reason: "SCANNER_TIMEOUT",
      coverage: {
        ...outcomes(),
        osv: "failed",
        zizmor: "unsupported",
        opengrep: "not_applicable",
      },
      specialistReasons: { osv: "SCANNER_TIMEOUT" },
      findings: [
        {
          schema_version: 1,
          finding_id: "fnd_0000000001",
          request_id: lease.requestId,
          repository_id: lease.repositoryId,
          commit_sha: "a".repeat(40),
          engine: "gitleaks",
          rule_id: "github-pat",
          category: "secret",
          severity: "high",
          confidence: "high",
          occurrence_bucket: "one",
          remediation_key: "rotate-secret",
          owner_detail_ref: "chunk_000001",
        },
      ],
      nowMs: 1_500,
    };

    await expect(
      store.publish({ ...input, specialistReasons: {} }),
    ).rejects.toThrow("invalid publication metadata");
    expect(await store.publish(input)).toBe("published");
    expect(await store.publish(input)).toBe("idempotent");
    expect(
      await store.publish({
        ...input,
        reason: "SCANNER_INTERNAL",
        specialistReasons: { osv: "SCANNER_INTERNAL" },
      }),
    ).toBe("idempotency_conflict");
    expect(
      (
        await store.listRepositories({
          requestId: lease.requestId,
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "partial",
      reason: "SCANNER_TIMEOUT",
      specialistReasons: { osv: "SCANNER_TIMEOUT" },
      coverage: { gitleaks: "complete", osv: "failed" },
    });
    expect(
      await store.listFindings({
        requestId: lease.requestId,
        afterFindingId: null,
        limit: 10,
      }),
    ).toMatchObject({ findings: input.findings });
    store.close();
  });

  it("publishes exactly once and compares same-key payloads", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    await createLedger(store, [1]);
    const claimed = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 1_000,
    });
    if (claimed === null) throw new Error("test expected claim");
    const lease = await advanceToWaitingToPublish(store, claimed, 1_200);
    const input: PublishInput = {
      ...publication(lease),
      findings: [
        {
          schema_version: 1,
          finding_id: "fnd_0000000001",
          request_id: lease.requestId,
          repository_id: lease.repositoryId,
          commit_sha: "a".repeat(40),
          engine: "gitleaks",
          rule_id: "github-pat",
          category: "secret",
          severity: "high",
          confidence: "high",
          occurrence_bucket: "one",
          remediation_key: "rotate-secret",
          owner_detail_ref: "chunk_000001",
        },
      ],
    };
    expect(await store.publish(input)).toBe("published");
    expect(await store.publish(input)).toBe("idempotent");
    expect(
      await store.publish({
        ...input,
        coverage: { ...input.coverage, osv: "unsupported" },
      }),
    ).toBe("idempotency_conflict");
    expect(
      await store.publish({ ...input, generation: input.generation + 1 }),
    ).toBe("idempotency_conflict");
    expect(
      await store.publish({
        ...input,
        findings: input.findings.map((finding) => ({
          ...finding,
          occurrence_bucket: "two_to_five",
        })),
      }),
    ).toBe("idempotency_conflict");
    expect(
      await store.listFindings({
        requestId: input.requestId,
        afterFindingId: null,
        limit: 10,
      }),
    ).toMatchObject({ findings: input.findings, nextFindingId: null });
    expect((await store.getRequest(input.requestId))?.state).toBe("complete");
    store.close();
  });

  it("marks a mixed terminal ledger complete only after the last row", async () => {
    const store = new SqliteStore({ filename: databasePath(), migrationTimeMs: 1 });
    const created = await createLedger(store, [1, 2]);
    const first = await store.claimNext({
      workerId: "worker_00000001",
      nowMs: 1_100,
      leaseDurationMs: 1_000,
    });
    if (first === null) throw new Error("test expected claim");
    const firstLease = await advanceToWaitingToPublish(store, first, 1_200);
    expect(await store.publish(publication(firstLease))).toBe("published");
    expect((await store.getRequest(created.requestId))?.state).toBe("scanning");

    const second = await store.claimNext({
      workerId: "worker_00000002",
      nowMs: 1_300,
      leaseDurationMs: 1_000,
    });
    if (second === null) throw new Error("test expected claim");
    const secondLease = leaseRef(second);
    expect(
      await store.transition({
        ...secondLease,
        expectedState: "leased",
        nextState: "acquiring",
        nowMs: 1_350,
      }),
    ).toBe(true);
    expect(
      await store.transition({
        ...secondLease,
        expectedState: "acquiring",
        nextState: "cleaning",
        nowMs: 1_360,
      }),
    ).toBe(true);
    expect(
      await store.publish({
        ...publication(secondLease, "partial", "FINDING_LIMIT"),
        coverage: outcomes("partial"),
      }),
    ).toBe("published");
    expect((await store.getRequest(created.requestId))?.state).toBe("complete");
    store.close();
  });
});
