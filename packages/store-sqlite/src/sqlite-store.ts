/* eslint-disable @typescript-eslint/require-await -- synchronous SQLite implements the async cross-runtime Store port */
import Database from "better-sqlite3";
import {
  SPECIALISTS,
  SCAN_ENGINES,
  brokerDerivedFindingSchema,
  commitShaSchema,
  failureClassSchema,
  githubLoginSchema,
  githubRepoNameSchema,
  opaqueIdSchema,
  repositoryStateSchema,
  scanRequestStateSchema,
  specialistReasonsSchema,
  repositoryCoverageSchema,
  repositoryStateTotalsSchema,
  coverageTotalsSchema,
  type AiLaneState,
  type BrokerDerivedFinding,
  type FailureClass,
  type GithubLogin,
  type OpaqueId,
  type RepositoryState,
  type ScanRequestState,
  type SpecialistProgressState,
} from "@app/contracts";
import {
  canTransition,
  emptyRequestTotals,
  validatePublishInput,
  LEASED_REPOSITORY_STATES,
  type ClaimInput,
  type CompleteDiscoveryInput,
  type CreateRequestInput,
  type DiscoveryCompletionResult,
  type ExhaustedLeaseRef,
  type FailRequestInput,
  type FindingPageInput,
  type FindingPageRecord,
  type FinalizeExhaustedInput,
  type HeartbeatInput,
  type LeaseIdentity,
  type PublicationResult,
  type PublishInput,
  type ReleaseInput,
  type ExpiredLeaseResult,
  type RepositoryPageInput,
  type RepositoryPageRecord,
  type RepositoryRecord,
  type RequestTotals,
  type ScanRequestRecord,
  type SpecialistProgress,
  type SpecialistReasons,
  type Store,
  type TransitionInput,
} from "@app/core";
import {
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
  MIGRATION_005,
  MIGRATION_006,
  MIGRATION_007,
  SCHEMA_VERSION,
} from "./migrations.js";
import { CLAIM_NEXT_SQL, MAX_LEASE_ATTEMPTS } from "./queries.js";

export interface SqliteStoreOptions {
  readonly filename: string;
  readonly migrationTimeMs?: number;
  /** Holds one exclusive local-runtime connection until close. */
  readonly exclusive?: boolean;
}

interface RequestRow {
  request_id: string;
  github_account_id: number | null;
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
  is_fork: number;
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
  specialist_reasons: string;
  coverage_json: string;
}

function parseSpecialistReasons(value: string): SpecialistReasons {
  try {
    const parsed = specialistReasonsSchema.parse(JSON.parse(value) as unknown);
    return Object.freeze(
      Object.fromEntries(
        SCAN_ENGINES.flatMap((engine) =>
          parsed[engine] === undefined ? [] : [[engine, parsed[engine]]],
        ),
      ),
    );
  } catch {
    throw new Error("invalid specialist reasons");
  }
}

function serializeSpecialistReasons(reasons: SpecialistReasons): string {
  const parsed = specialistReasonsSchema.safeParse(reasons);
  if (!parsed.success) throw new Error("invalid specialist reasons");
  return JSON.stringify(
    Object.fromEntries(
      SCAN_ENGINES.flatMap((engine) =>
        parsed.data[engine] === undefined
          ? []
          : [[engine, parsed.data[engine]]],
      ),
    ),
  );
}

function parseCoverage(value: string): SpecialistProgress {
  try {
    return repositoryCoverageSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new Error("invalid coverage row");
  }
}

function serializeCoverage(coverage: SpecialistProgress): string {
  return JSON.stringify(repositoryCoverageSchema.parse(coverage));
}

function parseRequestTotals(row: {
  repository_totals: string;
  coverage_totals: string;
}): RequestTotals {
  try {
    return {
      repositoryTotals: repositoryStateTotalsSchema.parse(
        JSON.parse(row.repository_totals) as unknown,
      ),
      coverageTotals: coverageTotalsSchema.parse(
        JSON.parse(row.coverage_totals) as unknown,
      ),
    };
  } catch {
    throw new Error("invalid request totals");
  }
}

function serializeRequestTotals(totals: RequestTotals): readonly [string, string] {
  return [
    JSON.stringify(repositoryStateTotalsSchema.parse(totals.repositoryTotals)),
    JSON.stringify(coverageTotalsSchema.parse(totals.coverageTotals)),
  ];
}

function uniformCoverage(state: SpecialistProgressState): SpecialistProgress {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [specialist, state]),
  ) as SpecialistProgress;
}

function discoveryTotals(
  repositories: CompleteDiscoveryInput["repositories"],
): RequestTotals {
  const totals = emptyRequestTotals();
  for (const repository of repositories) {
    const repositoryState = repository.commitSha === null ? "empty" : "waiting";
    const coverageState =
      repository.commitSha === null ? "not_applicable" : "waiting";
    totals.repositoryTotals[repositoryState] += 1;
    for (const specialist of SPECIALISTS) {
      totals.coverageTotals[specialist][coverageState] += 1;
    }
  }
  return totals;
}

const FAIL_WAITING_COVERAGE_SQL = `json_object(${SPECIALISTS.flatMap(
  (specialist) => [
    `'${specialist}'`,
    `CASE WHEN json_extract(coverage_json, '$.${specialist}') = 'waiting' THEN 'failed' ELSE json_extract(coverage_json, '$.${specialist}') END`,
  ],
).join(", ")})`;

interface FindingRow {
  finding_id: string;
  request_id: string;
  repository_id: number;
  commit_sha: string;
  engine: string;
  rule_id: string;
  category: string;
  severity: string;
  confidence: string;
  occurrence_bucket: string;
  remediation_key: string;
  owner_detail_ref: string;
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseFindingRow(row: FindingRow): BrokerDerivedFinding {
  const parsed = brokerDerivedFindingSchema.safeParse({
    schema_version: 1,
    finding_id: row.finding_id,
    request_id: row.request_id,
    repository_id: row.repository_id,
    commit_sha: row.commit_sha,
    engine: row.engine,
    rule_id: row.rule_id,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    occurrence_bucket: row.occurrence_bucket,
    remediation_key: row.remediation_key,
    owner_detail_ref: row.owner_detail_ref,
  });
  if (!parsed.success) throw new Error("invalid finding row");
  return parsed.data;
}

function sameFinding(
  left: BrokerDerivedFinding,
  right: BrokerDerivedFinding,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.finding_id === right.finding_id &&
    left.request_id === right.request_id &&
    left.repository_id === right.repository_id &&
    left.commit_sha === right.commit_sha &&
    left.engine === right.engine &&
    left.rule_id === right.rule_id &&
    left.category === right.category &&
    left.severity === right.severity &&
    left.confidence === right.confidence &&
    left.occurrence_bucket === right.occurrence_bucket &&
    left.remediation_key === right.remediation_key &&
    left.owner_detail_ref === right.owner_detail_ref
  );
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
    (row.github_account_id !== null &&
      !isSafeNonNegativeInteger(row.github_account_id)) ||
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

function parseRepositoryRow(row: RepositoryRow): RepositoryRecord {
  assertOpaqueId(row.request_id);
  if (
    !isSafeNonNegativeInteger(row.repository_id) ||
    !githubRepoNameSchema.safeParse(row.name).success ||
    (row.is_fork !== 0 && row.is_fork !== 1) ||
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
    isFork: row.is_fork === 1,
    commitSha: row.commit_sha,
    state: row.state as RepositoryState,
    reason: row.reason as FailureClass | null,
    coverage: parseCoverage(row.coverage_json),
    specialistReasons: parseSpecialistReasons(row.specialist_reasons),
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
      // A second local runtime is a configuration error, so exclusive startup
      // fails promptly instead of appearing to hang behind another process.
      this.#database.pragma(
        `busy_timeout = ${options.exclusive === true ? 250 : 5000}`,
      );
      if (options.exclusive === true) {
        this.#database.pragma("locking_mode = EXCLUSIVE");
      }
      // Version two rebuilds the request table to make the immutable GitHub id
      // nullable until discovery. SQLite requires foreign keys to be disabled
      // outside the migration transaction while that parent table is swapped.
      this.#database.pragma("foreign_keys = OFF");
      const migrate = this.#database.transaction(() => {
        this.#database.exec(MIGRATION_001);
        const recordMigration = this.#database.prepare(
          "INSERT OR IGNORE INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)",
        );
        recordMigration.run(1, migrationTimeMs);
        const versionTwo = this.#database
          .prepare("SELECT version FROM schema_migrations WHERE version = 2")
          .get() as { version: number } | undefined;
        if (versionTwo === undefined) {
          this.#database.exec(MIGRATION_002);
          recordMigration.run(2, migrationTimeMs);
        }
        const versionThree = this.#database
          .prepare("SELECT version FROM schema_migrations WHERE version = 3")
          .get() as { version: number } | undefined;
        if (versionThree === undefined) {
          this.#database.exec(MIGRATION_003);
          recordMigration.run(3, migrationTimeMs);
        }
        const versionFour = this.#database
          .prepare("SELECT version FROM schema_migrations WHERE version = 4")
          .get() as { version: number } | undefined;
        if (versionFour === undefined) {
          this.#database.exec(MIGRATION_004);
          recordMigration.run(4, migrationTimeMs);
        }
        const versionFive = this.#database
          .prepare("SELECT version FROM schema_migrations WHERE version = 5")
          .get() as { version: number } | undefined;
        if (versionFive === undefined) {
          this.#database.exec(MIGRATION_005);
          recordMigration.run(5, migrationTimeMs);
        }
        const versionSix = this.#database
          .prepare("SELECT version FROM schema_migrations WHERE version = 6")
          .get() as { version: number } | undefined;
        if (versionSix === undefined) {
          this.#database.exec(MIGRATION_006);
          recordMigration.run(6, migrationTimeMs);
        }
        const versionSeven = this.#database
          .prepare("SELECT version FROM schema_migrations WHERE version = 7")
          .get() as { version: number } | undefined;
        if (versionSeven === undefined) {
          this.#database.exec(MIGRATION_007);
          recordMigration.run(SCHEMA_VERSION, migrationTimeMs);
        }
      });
      migrate();
      if (options.exclusive === true) {
        // Make the lock real before startup orphan cleanup. Merely setting
        // locking_mode does not acquire it until a transaction runs.
        this.#database.exec("BEGIN EXCLUSIVE; COMMIT;");
      }
      const foreignKeyViolations = this.#database.pragma(
        "foreign_key_check",
      ) as unknown[];
      if (foreignKeyViolations.length > 0) {
        throw new Error("foreign key migration check failed");
      }
      this.#database.pragma("foreign_keys = ON");
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
      this.#database.transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO scan_requests(
              request_id, github_account_id, username, state, reason,
              discovery_complete, ai_lane, created_at_ms, updated_at_ms
            ) VALUES (?, NULL, ?, 'accepted', NULL, 0, 'ai_not_run', ?, ?)`,
          )
          .run(
            input.requestId,
            input.username,
            input.nowMs,
            input.nowMs,
          );
        const [repositoryTotals, coverageTotals] = serializeRequestTotals(
          emptyRequestTotals(),
        );
        this.#database
          .prepare(
            `INSERT INTO request_totals(
              request_id, repository_totals, coverage_totals
            ) VALUES (?, ?, ?)`,
          )
          .run(input.requestId, repositoryTotals, coverageTotals);
      })();
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
            request_id, repository_id, name, is_fork, commit_sha, state, reason,
            attempt_count, lease_owner, lease_generation, lease_expires_at_ms,
            published_lease_generation, discovered_at_ms, updated_at_ms,
            coverage_json
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, 0, NULL, NULL, ?, ?, ?)`,
        );
        for (const repository of input.repositories) {
          const state = repository.commitSha === null ? "empty" : "waiting";
          insertRepository.run(
            input.requestId,
            repository.repositoryId,
            repository.name,
            repository.isFork ? 1 : 0,
            repository.commitSha,
            state,
            input.nowMs,
            input.nowMs,
            serializeCoverage(
              uniformCoverage(
                repository.commitSha === null ? "not_applicable" : "waiting",
              ),
            ),
          );
        }
        const [repositoryTotals, coverageTotals] = serializeRequestTotals(
          discoveryTotals(input.repositories),
        );
        const totalsResult = this.#database
          .prepare(
            `UPDATE request_totals
             SET repository_totals = ?, coverage_totals = ?
             WHERE request_id = ?`,
          )
          .run(repositoryTotals, coverageTotals, input.requestId);
        if (totalsResult.changes !== 1) {
          throw new Error("discovery totals missing");
        }
        const completeImmediately = input.repositories.every(
          (repository) => repository.commitSha === null,
        );
        const result = this.#database
          .prepare(
            `UPDATE scan_requests
             SET github_account_id = ?, username = ?, state = ?, reason = NULL,
                 discovery_complete = 1, updated_at_ms = ?
             WHERE request_id = ? AND discovery_complete = 0
               AND state IN ('accepted','discovering')`,
          )
          .run(
            input.githubAccountId,
            input.canonicalLogin,
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

  async getRequestTotals(requestId: OpaqueId): Promise<RequestTotals | null> {
    assertOpaqueId(requestId);
    if ((await this.getRequest(requestId)) === null) return null;
    const row = this.#database
      .prepare(
        `SELECT repository_totals, coverage_totals FROM request_totals
         WHERE request_id = ?`,
      )
      .get(requestId) as
      | { repository_totals: string; coverage_totals: string }
      | undefined;
    if (row === undefined) throw new Error("request totals missing");
    return parseRequestTotals(row);
  }

  async findActiveRequestByUsername(
    username: GithubLogin,
  ): Promise<ScanRequestRecord | null> {
    if (!githubLoginSchema.safeParse(username).success) {
      throw new Error("invalid GitHub username");
    }
    const row = this.#database
      .prepare(
        `SELECT * FROM scan_requests
         WHERE username = ? COLLATE NOCASE
           AND state IN ('accepted','discovering','scanning')
         ORDER BY created_at_ms ASC LIMIT 1`,
      )
      .get(username) as RequestRow | undefined;
    return row === undefined ? null : parseRequestRow(row);
  }

  async listPendingDiscoveryRequests(
    limit: number,
  ): Promise<readonly ScanRequestRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("invalid pending-discovery limit");
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM scan_requests
         WHERE discovery_complete = 0
           AND state IN ('accepted','discovering')
         ORDER BY created_at_ms ASC, request_id ASC
         LIMIT ?`,
      )
      .all(limit) as RequestRow[];
    return rows.map(parseRequestRow);
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

  async listFindings(input: FindingPageInput): Promise<FindingPageRecord> {
    assertOpaqueId(input.requestId);
    if (input.afterFindingId !== null) assertOpaqueId(input.afterFindingId);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("invalid finding page");
    }
    const rows = this.#database
      .prepare(
        `SELECT * FROM findings
         WHERE request_id = ? AND finding_id > ?
         ORDER BY finding_id ASC LIMIT ?`,
      )
      .all(input.requestId, input.afterFindingId ?? "", input.limit + 1) as FindingRow[];
    const hasNext = rows.length > input.limit;
    const findings = (hasNext ? rows.slice(0, input.limit) : rows).map(
      parseFindingRow,
    );
    return {
      findings,
      nextFindingId:
        hasNext && findings.length > 0
          ? findings.at(-1)?.finding_id ?? null
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

  async classifyExpiredLeases(nowMs: number): Promise<ExpiredLeaseResult> {
    assertTime(nowMs);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    try {
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
      const retryable: ExhaustedLeaseRef[] = [];
      for (const row of rows) {
        assertOpaqueId(row.request_id);
        if (row.attempt_count >= MAX_LEASE_ATTEMPTS) {
          exhausted.push({
            requestId: row.request_id,
            repositoryId: row.repository_id,
            generation: row.lease_generation,
          });
        } else {
          retryable.push({
            requestId: row.request_id,
            repositoryId: row.repository_id,
            generation: row.lease_generation,
          });
        }
      }
      return { retryable, exhausted };
    } catch {
      throw new Error("expired lease classification failed");
    }
  }

  async requeueCleaned(input: FinalizeExhaustedInput): Promise<boolean> {
    this.#validateExpiredReference(input);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const result = this.#database
      .prepare(
        `UPDATE repositories
         SET state = 'waiting', reason = NULL, specialist_reasons = '{}', lease_owner = NULL,
             lease_expires_at_ms = NULL, updated_at_ms = ?
         WHERE request_id = ? AND repository_id = ?
           AND lease_generation = ? AND attempt_count < ?
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
    return result.changes === 1;
  }

  async finalizeExhausted(input: FinalizeExhaustedInput): Promise<boolean> {
    this.#validateExpiredReference(input);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const finalize = this.#database.transaction((): boolean => {
      const result = this.#database
        .prepare(
          `UPDATE repositories
           SET state = 'failed', reason = 'LEASE_RETRY_EXHAUSTED', specialist_reasons = '{}',
               coverage_json = ${FAIL_WAITING_COVERAGE_SQL}, lease_owner = NULL,
               lease_expires_at_ms = NULL, updated_at_ms = ?
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
             AND state = 'leased'
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
             SET state = 'waiting', reason = NULL, specialist_reasons = '{}', lease_owner = NULL,
                 lease_expires_at_ms = NULL, updated_at_ms = ?
             WHERE request_id = ? AND repository_id = ?
               AND state = 'leased'
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

  async retryCleaned(input: ReleaseInput): Promise<boolean> {
    this.#validateLeaseRef(input);
    assertTime(input.nowMs);
    const result = this.#database
      .prepare(
        `UPDATE repositories
         SET state = 'waiting', reason = NULL, specialist_reasons = '{}', lease_owner = NULL,
             lease_expires_at_ms = NULL, updated_at_ms = ?
         WHERE request_id = ? AND repository_id = ?
           AND state = 'cleaning'
           AND lease_owner = ? AND lease_generation = ?
           AND lease_expires_at_ms > ?
           AND published_lease_generation IS NULL
           AND attempt_count < ?`,
      )
      .run(
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.workerId,
        input.generation,
        input.nowMs,
        MAX_LEASE_ATTEMPTS,
      );
    return result.changes === 1;
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
    validatePublishInput(input);
    serializeSpecialistReasons(input.specialistReasons);
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
        if (
          row.commit_sha === null ||
          input.findings.some((finding) => finding.commit_sha !== row.commit_sha)
        ) {
          throw new Error("finding commit mismatch");
        }

        // At-least-once retry is checked before lease staleness. The key is
        // server-derived from repository/commit identity plus lease generation;
        // the worker supplies no arbitrary idempotency string.
        if (row.published_lease_generation !== null) {
          if (row.published_lease_generation !== input.generation) {
            return "idempotency_conflict";
          }
          const currentCoverage = parseCoverage(row.coverage_json);
          const sameCoverage = SPECIALISTS.every(
            (specialist) => currentCoverage[specialist] === input.coverage[specialist],
          );
          const sameSpecialistReasons =
            row.specialist_reasons ===
            serializeSpecialistReasons(input.specialistReasons);
          return row.state === input.terminalState &&
            row.reason === input.reason &&
            sameCoverage &&
            sameSpecialistReasons &&
            this.#publicationFindingsMatch(input)
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

        const insertFinding = this.#database.prepare(
          `INSERT INTO findings(
            finding_id, request_id, repository_id, commit_sha, engine,
            rule_id, category, severity, confidence, occurrence_bucket,
            remediation_key, owner_detail_ref
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const finding of input.findings) {
          insertFinding.run(
            finding.finding_id,
            finding.request_id,
            finding.repository_id,
            finding.commit_sha,
            finding.engine,
            finding.rule_id,
            finding.category,
            finding.severity,
            finding.confidence,
            finding.occurrence_bucket,
            finding.remediation_key,
            finding.owner_detail_ref,
          );
        }

        const result = this.#database
          .prepare(
            `UPDATE repositories
             SET state = ?, reason = ?, specialist_reasons = ?, coverage_json = ?,
                 published_lease_generation = ?, lease_owner = NULL,
                 lease_expires_at_ms = NULL, updated_at_ms = ?
             WHERE request_id = ? AND repository_id = ?
               AND state = ? AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at_ms > ?`,
          )
          .run(
            input.terminalState,
            input.reason,
            serializeSpecialistReasons(input.specialistReasons),
            serializeCoverage(input.coverage),
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
    return parseRepositoryRow(row);
  }

  #publicationFindingsMatch(input: PublishInput): boolean {
    const rows = this.#database
      .prepare(
        `SELECT * FROM findings
         WHERE request_id = ? AND repository_id = ? ORDER BY finding_id`,
      )
      .all(input.requestId, input.repositoryId) as FindingRow[];
    const current = rows.map(parseFindingRow);
    const expected = [...input.findings].toSorted((left, right) =>
      left.finding_id.localeCompare(right.finding_id),
    );
    return (
      current.length === expected.length &&
      current.every((finding, index) => {
        const candidate = expected[index];
        return candidate !== undefined && sameFinding(finding, candidate);
      })
    );
  }

  #validateCreateInput(input: CreateRequestInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (!githubLoginSchema.safeParse(input.username).success) {
      throw new Error("invalid request input");
    }
  }

  #validateDiscoveryInput(input: CompleteDiscoveryInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (
      !isSafeNonNegativeInteger(input.githubAccountId) ||
      !githubLoginSchema.safeParse(input.canonicalLogin).success
    ) {
      throw new Error("invalid discovered account");
    }
    const ids = new Set<number>();
    for (const repository of input.repositories) {
      if (
        !isSafeNonNegativeInteger(repository.repositoryId) ||
        ids.has(repository.repositoryId) ||
        !githubRepoNameSchema.safeParse(repository.name).success ||
        typeof repository.isFork !== "boolean" ||
        (repository.commitSha !== null &&
          !commitShaSchema.safeParse(repository.commitSha).success)
      ) {
        throw new Error("invalid repository ledger input");
      }
      ids.add(repository.repositoryId);
    }
  }

  #discoveryMatches(input: CompleteDiscoveryInput): boolean {
    const request = this.#database
      .prepare(
        "SELECT github_account_id, username FROM scan_requests WHERE request_id = ?",
      )
      .get(input.requestId) as
      | { github_account_id: number | null; username: string }
      | undefined;
    if (
      request === undefined ||
      request.github_account_id !== input.githubAccountId ||
      request.username !== input.canonicalLogin
    ) {
      return false;
    }
    const rows = this.#database
      .prepare(
        `SELECT repository_id, name, is_fork, commit_sha FROM repositories
         WHERE request_id = ? ORDER BY repository_id`,
      )
      .all(input.requestId) as Array<{
      repository_id: number;
      name: string;
      is_fork: number;
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
          row.is_fork === (repository.isFork ? 1 : 0) &&
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

  #validateExpiredReference(input: FinalizeExhaustedInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (
      !isSafeNonNegativeInteger(input.repositoryId) ||
      !isSafeNonNegativeInteger(input.generation) ||
      input.generation === 0
    ) {
      throw new Error("invalid expired lease reference");
    }
  }

}
