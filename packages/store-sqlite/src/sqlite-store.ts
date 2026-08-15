/* eslint-disable @typescript-eslint/require-await -- synchronous SQLite implements the async cross-runtime Store port */
import Database from "better-sqlite3";
import {
  SPECIALISTS,
  commitShaSchema,
  failureClassSchema,
  githubLoginSchema,
  githubRepoNameSchema,
  opaqueIdSchema,
  repositoryStateSchema,
  scanRequestStateSchema,
  specialistCoverageOutcomeSchema,
  specialistProgressStateSchema,
  type AiLaneState,
  type FailureClass,
  type OpaqueId,
  type RepositoryState,
  type ScanRequestState,
  type Specialist,
  type SpecialistProgressState,
} from "@app/contracts";
import {
  canTransition,
  LEASED_REPOSITORY_STATES,
  type ClaimInput,
  type CompleteDiscoveryInput,
  type CreateRequestInput,
  type DiscoveryCompletionResult,
  type ExhaustedLeaseRef,
  type FailRequestInput,
  type FinalizeExhaustedInput,
  type HeartbeatInput,
  type LeaseIdentity,
  type PublicationResult,
  type PublishInput,
  type ReleaseInput,
  type RequeueExpiredResult,
  type RepositoryPageInput,
  type RepositoryPageRecord,
  type RepositoryRecord,
  type ScanRequestRecord,
  type SpecialistProgress,
  type Store,
  type TransitionInput,
} from "@app/core";
import { MIGRATION_001, SCHEMA_VERSION } from "./migrations.js";
import { CLAIM_NEXT_SQL, MAX_LEASE_ATTEMPTS } from "./queries.js";

export interface SqliteStoreOptions {
  readonly filename: string;
  readonly migrationTimeMs?: number;
}

interface RequestRow {
  request_id: string;
  github_account_id: number;
  username: string;
  state: string;
  reason: string | null;
  discovery_complete: number;
  ai_lane: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface RepositoryRow {
  request_id: string;
  repository_id: number;
  name: string;
  commit_sha: string | null;
  state: string;
  reason: string | null;
  attempt_count: number;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at_ms: number | null;
  published_lease_generation: number | null;
  discovered_at_ms: number;
  updated_at_ms: number;
}

interface CoverageRow {
  specialist: string;
  progress_state: string;
}


function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertTime(value: number): void {
  if (!isSafeNonNegativeInteger(value)) {
    throw new Error("invalid store time");
  }
}

function assertOpaqueId(value: string): asserts value is OpaqueId {
  if (!opaqueIdSchema.safeParse(value).success) {
    throw new Error("invalid opaque identifier");
  }
}

function parseRequestRow(row: RequestRow): ScanRequestRecord {
  assertOpaqueId(row.request_id);
  if (
    !isSafeNonNegativeInteger(row.github_account_id) ||
    !githubLoginSchema.safeParse(row.username).success ||
    !scanRequestStateSchema.safeParse(row.state).success ||
    (row.reason !== null && !failureClassSchema.safeParse(row.reason).success) ||
    (row.discovery_complete !== 0 && row.discovery_complete !== 1) ||
    !["ai_not_run", "ai_waiting", "ai_partial"].includes(row.ai_lane) ||
    !isSafeNonNegativeInteger(row.created_at_ms) ||
    !isSafeNonNegativeInteger(row.updated_at_ms)
  ) {
    throw new Error("invalid request row");
  }
  return {
    schemaVersion: 1,
    requestId: row.request_id,
    githubAccountId: row.github_account_id,
    username: row.username,
    state: row.state as ScanRequestState,
    reason: row.reason as FailureClass | null,
    discoveryComplete: row.discovery_complete === 1,
    aiLane: row.ai_lane as AiLaneState,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function coverageFromRows(rows: readonly CoverageRow[]): SpecialistProgress {
  if (rows.length !== SPECIALISTS.length) {
    throw new Error("invalid coverage row count");
  }
  const entries = new Map<Specialist, SpecialistProgressState>();
  for (const row of rows) {
    if (
      !SPECIALISTS.includes(row.specialist as Specialist) ||
      !specialistProgressStateSchema.safeParse(row.progress_state).success ||
      entries.has(row.specialist as Specialist)
    ) {
      throw new Error("invalid coverage row");
    }
    entries.set(
      row.specialist as Specialist,
      row.progress_state as SpecialistProgressState,
    );
  }
  return Object.fromEntries(entries) as SpecialistProgress;
}

function parseRepositoryRow(
  row: RepositoryRow,
  coverage: SpecialistProgress,
): RepositoryRecord {
  assertOpaqueId(row.request_id);
  if (
    !isSafeNonNegativeInteger(row.repository_id) ||
    !githubRepoNameSchema.safeParse(row.name).success ||
    (row.commit_sha !== null && !commitShaSchema.safeParse(row.commit_sha).success) ||
    !repositoryStateSchema.safeParse(row.state).success ||
    (row.reason !== null && !failureClassSchema.safeParse(row.reason).success) ||
    !isSafeNonNegativeInteger(row.attempt_count) ||
    !isSafeNonNegativeInteger(row.lease_generation) ||
    !isSafeNonNegativeInteger(row.discovered_at_ms) ||
    !isSafeNonNegativeInteger(row.updated_at_ms)
  ) {
    throw new Error("invalid repository row");
  }
  if (row.lease_owner !== null) {
    assertOpaqueId(row.lease_owner);
  }
  if (
    (row.lease_owner === null) !== (row.lease_expires_at_ms === null) ||
    (row.lease_expires_at_ms !== null &&
      !isSafeNonNegativeInteger(row.lease_expires_at_ms)) ||
    (row.published_lease_generation !== null &&
      (!isSafeNonNegativeInteger(row.published_lease_generation) ||
        row.published_lease_generation === 0))
  ) {
    throw new Error("invalid lease row");
  }
  const lease: LeaseIdentity | null =
    row.lease_owner === null || row.lease_expires_at_ms === null
      ? null
      : {
          workerId: row.lease_owner,
          generation: row.lease_generation,
          expiresAtMs: row.lease_expires_at_ms,
        };
  return {
    schemaVersion: 1,
    requestId: row.request_id,
    repositoryId: row.repository_id,
    name: row.name,
    commitSha: row.commit_sha,
    state: row.state as RepositoryState,
    reason: row.reason as FailureClass | null,
    coverage,
    attemptCount: row.attempt_count,
    leaseGeneration: row.lease_generation,
    lease,
    publishedLeaseGeneration: row.published_lease_generation,
    discoveredAtMs: row.discovered_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export class SqliteStore implements Store {
  readonly #database: Database.Database;

  constructor(options: SqliteStoreOptions) {
    if (options.filename.length === 0) {
      throw new Error("invalid database filename");
    }
    const migrationTimeMs = options.migrationTimeMs ?? Date.now();
    assertTime(migrationTimeMs);
    try {
      this.#database = new Database(options.filename);
      this.#database.pragma("foreign_keys = ON");
      this.#database.pragma("busy_timeout = 5000");
      this.#database.exec(MIGRATION_001);
      this.#database
        .prepare(
          "INSERT OR IGNORE INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)",
        )
        .run(SCHEMA_VERSION, migrationTimeMs);
    } catch {
      throw new Error("store initialization failed");
    }
  }

  close(): void {
    this.#database.close();
  }

  async createRequest(input: CreateRequestInput): Promise<ScanRequestRecord> {
    this.#validateCreateInput(input);
    try {
      this.#database
        .prepare(
          `INSERT INTO scan_requests(
            request_id, github_account_id, username, state, reason,
            discovery_complete, ai_lane, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'accepted', NULL, 0, 'ai_not_run', ?, ?)`,
        )
        .run(
          input.requestId,
          input.githubAccountId,
          input.username,
          input.nowMs,
          input.nowMs,
        );
    } catch {
      throw new Error("request creation failed");
    }
    const created = await this.getRequest(input.requestId);
    if (created === null) {
      throw new Error("request creation failed");
    }
    return created;
  }

  async startDiscovery(requestId: OpaqueId, nowMs: number): Promise<boolean> {
    assertOpaqueId(requestId);
    assertTime(nowMs);
    const result = this.#database
      .prepare(
        `UPDATE scan_requests SET state = 'discovering', updated_at_ms = ?
         WHERE request_id = ? AND discovery_complete = 0
           AND state IN ('accepted','discovering')`,
      )
      .run(nowMs, requestId);
    return result.changes === 1;
  }

  async completeDiscovery(
    input: CompleteDiscoveryInput,
  ): Promise<DiscoveryCompletionResult> {
    this.#validateDiscoveryInput(input);
    const complete = this.#database.transaction(
      (): DiscoveryCompletionResult => {
        const request = this.#database
          .prepare("SELECT * FROM scan_requests WHERE request_id = ?")
          .get(input.requestId) as RequestRow | undefined;
        if (request === undefined || request.state === "failed") {
          return "invalid_state";
        }
        if (request.discovery_complete === 1) {
          return this.#discoveryMatches(input) ? "idempotent" : "conflict";
        }
        if (request.state !== "accepted" && request.state !== "discovering") {
          return "invalid_state";
        }

        const insertRepository = this.#database.prepare(
          `INSERT INTO repositories(
            request_id, repository_id, name, commit_sha, state, reason,
            attempt_count, lease_owner, lease_generation, lease_expires_at_ms,
            published_lease_generation, discovered_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, 0, NULL, NULL, ?, ?)`,
        );
        const insertCoverage = this.#database.prepare(
          `INSERT INTO repository_coverage(
            request_id, repository_id, specialist, progress_state
          ) VALUES (?, ?, ?, ?)`,
        );
        for (const repository of input.repositories) {
          const state = repository.commitSha === null ? "empty" : "waiting";
          insertRepository.run(
            input.requestId,
            repository.repositoryId,
            repository.name,
            repository.commitSha,
            state,
            input.nowMs,
            input.nowMs,
          );
          for (const specialist of SPECIALISTS) {
            insertCoverage.run(
              input.requestId,
              repository.repositoryId,
              specialist,
              state === "empty" ? "not_applicable" : "waiting",
            );
          }
        }
        const completeImmediately = input.repositories.every(
          (repository) => repository.commitSha === null,
        );
        const result = this.#database
          .prepare(
            `UPDATE scan_requests
             SET state = ?, reason = NULL, discovery_complete = 1, updated_at_ms = ?
             WHERE request_id = ? AND discovery_complete = 0
               AND state IN ('accepted','discovering')`,
          )
          .run(
            completeImmediately ? "complete" : "scanning",
            input.nowMs,
            input.requestId,
          );
        if (result.changes !== 1) {
          throw new Error("discovery state changed");
        }
        return "completed";
      },
    );
    try {
      return complete();
    } catch {
      throw new Error("discovery completion failed");
    }
  }

  async failRequest(input: FailRequestInput): Promise<boolean> {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (!failureClassSchema.safeParse(input.reason).success) {
      throw new Error("invalid request failure");
    }
    const result = this.#database
      .prepare(
        `UPDATE scan_requests
         SET state = 'failed', reason = ?, updated_at_ms = ?
         WHERE request_id = ? AND discovery_complete = 0
           AND state IN ('accepted','discovering')`,
      )
      .run(input.reason, input.nowMs, input.requestId);
    return result.changes === 1;
  }

  async getRequest(requestId: OpaqueId): Promise<ScanRequestRecord | null> {
    assertOpaqueId(requestId);
    const row = this.#database
      .prepare("SELECT * FROM scan_requests WHERE request_id = ?")
      .get(requestId) as RequestRow | undefined;
    return row === undefined ? null : parseRequestRow(row);
  }

  async listRepositories(
    input: RepositoryPageInput,
  ): Promise<RepositoryPageRecord> {
    assertOpaqueId(input.requestId);
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.afterRepositoryId !== null &&
        !isSafeNonNegativeInteger(input.afterRepositoryId))
    ) {
      throw new Error("invalid repository page");
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM repositories
         WHERE request_id = ? AND repository_id > ?
         ORDER BY repository_id ASC LIMIT ?`,
      )
      .all(
        input.requestId,
        input.afterRepositoryId ?? -1,
        input.limit + 1,
      ) as RepositoryRow[];
    const hasNext = rows.length > input.limit;
    const pageRows = hasNext ? rows.slice(0, input.limit) : rows;
    const repositories = pageRows.map((row) => this.#hydrateRepository(row));
    return {
      repositories,
      nextRepositoryId:
        hasNext && repositories.length > 0
          ? repositories.at(-1)?.repositoryId ?? null
          : null,
    };
  }

  async claimNext(input: ClaimInput): Promise<RepositoryRecord | null> {
    assertOpaqueId(input.workerId);
    assertTime(input.nowMs);
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error("invalid lease duration");
    }
    const expiresAtMs = input.nowMs + input.leaseDurationMs;
    assertTime(expiresAtMs);
    const row = this.#database
      .prepare(CLAIM_NEXT_SQL)
      .get(input.workerId, expiresAtMs, input.nowMs) as RepositoryRow | undefined;
    return row === undefined ? null : this.#hydrateRepository(row);
  }

  async heartbeat(input: HeartbeatInput): Promise<boolean> {
    this.#validateLeaseRef(input);
    assertTime(input.nowMs);
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error("invalid lease duration");
    }
    const expiresAtMs = input.nowMs + input.leaseDurationMs;
    assertTime(expiresAtMs);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const result = this.#database
      .prepare(
        `UPDATE repositories
         SET lease_expires_at_ms = ?, updated_at_ms = ?
         WHERE request_id = ? AND repository_id = ?
           AND lease_owner = ? AND lease_generation = ?
           AND lease_expires_at_ms > ?
           AND state IN (${placeholders})`,
      )
      .run(
        expiresAtMs,
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.workerId,
        input.generation,
        input.nowMs,
        ...LEASED_REPOSITORY_STATES,
      );
    return result.changes === 1;
  }

  async requeueExpiredLeases(nowMs: number): Promise<RequeueExpiredResult> {
    assertTime(nowMs);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const requeue = this.#database.transaction((): RequeueExpiredResult => {
      const rows = this.#database
        .prepare(
          `SELECT request_id, repository_id, attempt_count, lease_generation
           FROM repositories
           WHERE lease_expires_at_ms IS NOT NULL
             AND lease_expires_at_ms <= ?
             AND state IN (${placeholders})`,
        )
        .all(nowMs, ...LEASED_REPOSITORY_STATES) as Array<{
        request_id: string;
        repository_id: number;
        attempt_count: number;
        lease_generation: number;
      }>;
      const exhausted: ExhaustedLeaseRef[] = [];
      let requeued = 0;
      for (const row of rows) {
        if (row.attempt_count >= MAX_LEASE_ATTEMPTS) {
          assertOpaqueId(row.request_id);
          exhausted.push({
            requestId: row.request_id,
            repositoryId: row.repository_id,
            generation: row.lease_generation,
          });
        } else {
          const result = this.#database
            .prepare(
              `UPDATE repositories
               SET state = 'waiting', reason = NULL, lease_owner = NULL,
                   lease_expires_at_ms = NULL, updated_at_ms = ?
               WHERE request_id = ? AND repository_id = ?
                 AND lease_expires_at_ms IS NOT NULL
                 AND lease_expires_at_ms <= ?`,
            )
            .run(nowMs, row.request_id, row.repository_id, nowMs);
          requeued += result.changes;
        }
      }
      return { requeued, exhausted };
    });
    try {
      return requeue();
    } catch {
      throw new Error("lease requeue failed");
    }
  }

  async finalizeExhausted(input: FinalizeExhaustedInput): Promise<boolean> {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (
      !isSafeNonNegativeInteger(input.repositoryId) ||
      !isSafeNonNegativeInteger(input.generation) ||
      input.generation === 0
    ) {
      throw new Error("invalid exhausted lease reference");
    }
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const finalize = this.#database.transaction((): boolean => {
      const result = this.#database
        .prepare(
          `UPDATE repositories
           SET state = 'failed', reason = 'LEASE_RETRY_EXHAUSTED',
               lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
           WHERE request_id = ? AND repository_id = ?
             AND lease_generation = ? AND attempt_count >= ?
             AND lease_expires_at_ms IS NOT NULL
             AND lease_expires_at_ms <= ?
             AND published_lease_generation IS NULL
             AND state IN (${placeholders})`,
        )
        .run(
          input.nowMs,
          input.requestId,
          input.repositoryId,
          input.generation,
          MAX_LEASE_ATTEMPTS,
          input.nowMs,
          ...LEASED_REPOSITORY_STATES,
        );
      if (result.changes !== 1) {
        return false;
      }
      this.#database
        .prepare(
          `UPDATE repository_coverage
           SET progress_state = CASE
             WHEN progress_state = 'waiting' THEN 'failed'
             ELSE progress_state END
           WHERE request_id = ? AND repository_id = ?`,
        )
        .run(input.requestId, input.repositoryId);
      this.#refreshRequestState(input.requestId, input.nowMs);
      return true;
    });
    try {
      return finalize();
    } catch {
      throw new Error("exhausted lease finalization failed");
    }
  }

  async release(input: ReleaseInput): Promise<boolean> {
    this.#validateLeaseRef(input);
    assertTime(input.nowMs);
    const release = this.#database.transaction((): boolean => {
      const row = this.#database
        .prepare(
          `SELECT attempt_count FROM repositories
           WHERE request_id = ? AND repository_id = ?
             AND lease_owner = ? AND lease_generation = ?
             AND lease_expires_at_ms > ?`,
        )
        .get(
          input.requestId,
          input.repositoryId,
          input.workerId,
          input.generation,
          input.nowMs,
        ) as { attempt_count: number } | undefined;
      if (row === undefined) {
        return false;
      }
      if (row.attempt_count >= MAX_LEASE_ATTEMPTS) {
        // A source-bearing attempt may not become terminal before the janitor
        // proves removal. Leave the exact expired generation for two-phase
        // recovery instead of bypassing the cleaning gate.
        return false;
      } else {
        this.#database
          .prepare(
            `UPDATE repositories
             SET state = 'waiting', reason = NULL, lease_owner = NULL,
                 lease_expires_at_ms = NULL, updated_at_ms = ?
             WHERE request_id = ? AND repository_id = ?
               AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at_ms > ?`,
          )
          .run(
            input.nowMs,
            input.requestId,
            input.repositoryId,
            input.workerId,
            input.generation,
            input.nowMs,
          );
      }
      this.#refreshRequestState(input.requestId, input.nowMs);
      return true;
    });
    try {
      return release();
    } catch {
      throw new Error("lease release failed");
    }
  }

  async transition(input: TransitionInput): Promise<boolean> {
    this.#validateLeaseRef(input);
    assertTime(input.nowMs);
    if (!canTransition(input.expectedState, input.nextState)) {
      return false;
    }
    const result = this.#database
      .prepare(
        `UPDATE repositories SET state = ?, updated_at_ms = ?
         WHERE request_id = ? AND repository_id = ?
           AND state = ? AND lease_owner = ? AND lease_generation = ?
           AND lease_expires_at_ms > ?`,
      )
      .run(
        input.nextState,
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.expectedState,
        input.workerId,
        input.generation,
        input.nowMs,
      );
    return result.changes === 1;
  }

  async publish(input: PublishInput): Promise<PublicationResult> {
    this.#validatePublishInput(input);
    const publishTransaction = this.#database.transaction(
      (): PublicationResult => {
        const row = this.#database
          .prepare(
            "SELECT * FROM repositories WHERE request_id = ? AND repository_id = ?",
          )
          .get(input.requestId, input.repositoryId) as RepositoryRow | undefined;
        if (row === undefined) {
          return "stale_lease";
        }

        // At-least-once retry is checked before lease staleness. The key is
        // server-derived from repository/commit identity plus lease generation;
        // the worker supplies no arbitrary idempotency string.
        if (row.published_lease_generation !== null) {
          if (row.published_lease_generation !== input.generation) {
            return "idempotency_conflict";
          }
          const currentCoverage = this.#readCoverage(
            input.requestId,
            input.repositoryId,
          );
          const sameCoverage = SPECIALISTS.every(
            (specialist) => currentCoverage[specialist] === input.coverage[specialist],
          );
          return row.state === input.terminalState &&
            row.reason === input.reason &&
            sameCoverage
            ? "idempotent"
            : "idempotency_conflict";
        }

        if (
          row.lease_owner !== input.workerId ||
          row.lease_generation !== input.generation ||
          row.lease_expires_at_ms === null ||
          row.lease_expires_at_ms <= input.nowMs
        ) {
          return "stale_lease";
        }
        if (
          !repositoryStateSchema.safeParse(row.state).success ||
          !canTransition(row.state as RepositoryState, input.terminalState)
        ) {
          return "invalid_state";
        }

        const updateCoverage = this.#database.prepare(
          `UPDATE repository_coverage SET progress_state = ?
           WHERE request_id = ? AND repository_id = ? AND specialist = ?`,
        );
        for (const specialist of SPECIALISTS) {
          const result = updateCoverage.run(
            input.coverage[specialist],
            input.requestId,
            input.repositoryId,
            specialist,
          );
          if (result.changes !== 1) {
            throw new Error("coverage publication failed");
          }
        }

        const result = this.#database
          .prepare(
            `UPDATE repositories
             SET state = ?, reason = ?, published_lease_generation = ?,
                 lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
             WHERE request_id = ? AND repository_id = ?
               AND state = ? AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at_ms > ?`,
          )
          .run(
            input.terminalState,
            input.reason,
            input.generation,
            input.nowMs,
            input.requestId,
            input.repositoryId,
            row.state,
            input.workerId,
            input.generation,
            input.nowMs,
          );
        if (result.changes !== 1) {
          throw new Error("publication state changed");
        }
        this.#refreshRequestState(input.requestId, input.nowMs);
        return "published";
      },
    );
    try {
      return publishTransaction();
    } catch {
      throw new Error("publication transaction failed");
    }
  }

  #hydrateRepository(row: RepositoryRow): RepositoryRecord {
    assertOpaqueId(row.request_id);
    return parseRepositoryRow(
      row,
      this.#readCoverage(row.request_id, row.repository_id),
    );
  }

  #readCoverage(
    requestId: OpaqueId,
    repositoryId: number,
  ): SpecialistProgress {
    const rows = this.#database
      .prepare(
        `SELECT specialist, progress_state FROM repository_coverage
         WHERE request_id = ? AND repository_id = ? ORDER BY specialist`,
      )
      .all(requestId, repositoryId) as CoverageRow[];
    return coverageFromRows(rows);
  }

  #validateCreateInput(input: CreateRequestInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (
      !isSafeNonNegativeInteger(input.githubAccountId) ||
      !githubLoginSchema.safeParse(input.username).success
    ) {
      throw new Error("invalid request input");
    }
  }

  #validateDiscoveryInput(input: CompleteDiscoveryInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    const ids = new Set<number>();
    for (const repository of input.repositories) {
      if (
        !isSafeNonNegativeInteger(repository.repositoryId) ||
        ids.has(repository.repositoryId) ||
        !githubRepoNameSchema.safeParse(repository.name).success ||
        (repository.commitSha !== null &&
          !commitShaSchema.safeParse(repository.commitSha).success)
      ) {
        throw new Error("invalid repository ledger input");
      }
      ids.add(repository.repositoryId);
    }
  }

  #discoveryMatches(input: CompleteDiscoveryInput): boolean {
    const rows = this.#database
      .prepare(
        `SELECT repository_id, name, commit_sha FROM repositories
         WHERE request_id = ? ORDER BY repository_id`,
      )
      .all(input.requestId) as Array<{
      repository_id: number;
      name: string;
      commit_sha: string | null;
    }>;
    const expected = [...input.repositories].toSorted(
      (left, right) => left.repositoryId - right.repositoryId,
    );
    return (
      rows.length === expected.length &&
      rows.every((row, index) => {
        const repository = expected[index];
        return (
          repository !== undefined &&
          row.repository_id === repository.repositoryId &&
          row.name === repository.name &&
          row.commit_sha === repository.commitSha
        );
      })
    );
  }

  #refreshRequestState(requestId: string, nowMs: number): void {
    this.#database
      .prepare(
        `UPDATE scan_requests
         SET state = CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM repositories
             WHERE repositories.request_id = scan_requests.request_id
               AND repositories.state NOT IN ('complete','empty','partial','failed','cancelled')
           ) THEN 'complete' ELSE 'scanning' END,
           updated_at_ms = ?
         WHERE request_id = ? AND discovery_complete = 1`,
      )
      .run(nowMs, requestId);
  }

  #validateLeaseRef(input: {
    requestId: OpaqueId;
    repositoryId: number;
    workerId: OpaqueId;
    generation: number;
  }): void {
    assertOpaqueId(input.requestId);
    assertOpaqueId(input.workerId);
    if (
      !isSafeNonNegativeInteger(input.repositoryId) ||
      !isSafeNonNegativeInteger(input.generation) ||
      input.generation === 0
    ) {
      throw new Error("invalid lease reference");
    }
  }

  #validatePublishInput(input: PublishInput): void {
    this.#validateLeaseRef(input);
    assertTime(input.nowMs);
    if (
      !["complete", "partial", "failed", "cancelled"].includes(
        input.terminalState,
      ) ||
      (input.terminalState === "complete" && input.reason !== null) ||
      (input.terminalState !== "complete" && input.reason === null) ||
      (input.reason !== null && !failureClassSchema.safeParse(input.reason).success)
    ) {
      throw new Error("invalid publication metadata");
    }
    for (const specialist of SPECIALISTS) {
      if (!specialistCoverageOutcomeSchema.safeParse(input.coverage[specialist]).success) {
        throw new Error("invalid publication coverage");
      }
    }
  }
}
