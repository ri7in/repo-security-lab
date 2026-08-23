import {
  SCAN_ENGINES,
  SPECIALISTS,
  brokerDerivedFindingSchema,
  commitShaSchema,
  coverageTotalsSchema,
  failureClassSchema,
  githubLoginSchema,
  githubRepoNameSchema,
  opaqueIdSchema,
  repositoryCoverageSchema,
  repositoryStateSchema,
  repositoryStateTotalsSchema,
  scanRequestStateSchema,
  specialistReasonsSchema,
  type AiLaneState,
  type BrokerDerivedFinding,
  type FailureClass,
  type GithubLogin,
  type OpaqueId,
  type RepositoryState,
  type ScanRequestState,
} from "@app/contracts";
import {
  LEASED_REPOSITORY_STATES,
  MAX_LEASE_ATTEMPTS,
  canTransition,
  emptyRequestTotals,
  validatePublishInput,
  type ClaimInput,
  type CompleteDiscoveryInput,
  type CreateRequestInput,
  type DiscoveryCompletionResult,
  type ExhaustedLeaseRef,
  type ExpiredLeaseResult,
  type FailRequestInput,
  type FinalizeExhaustedInput,
  type FindingPageInput,
  type FindingPageRecord,
  type HeartbeatInput,
  type LeaseIdentity,
  type PublicationResult,
  type PublishInput,
  type ReleaseInput,
  type RepositoryPageInput,
  type RepositoryPageRecord,
  type RepositoryRecord,
  type RequestTotals,
  type ScanRequestRecord,
  type SpecialistProgress,
  type SpecialistReasons,
  type Store,
  StoreWriteReserveError,
  type TransitionInput,
} from "@app/core";
import type { D1Database, D1PreparedStatement, D1Value } from "./d1-types.js";

const MAX_DISCOVERY_JSON_BYTES = 1_750_000;
const MAX_EXPIRED_PER_PASS = 100;
const FINDINGS_PER_CHUNK = 100;
const MODELED_REQUEST_WRITES = 10;
const MODELED_DISCOVERY_WRITES = 5;
const MODELED_WRITES_PER_REPOSITORY = 70;
const textEncoder = new TextEncoder();

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
  locations_json: string | null;
}

interface FindingChunkRow {
  findings_json: string;
}

function safeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertTime(value: number): void {
  if (!safeNonNegativeInteger(value)) throw new Error("invalid store time");
}

function utcDay(nowMs: number): string {
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid store time");
  return date.toISOString().slice(0, 10);
}

function assertOpaqueId(value: string): asserts value is OpaqueId {
  if (!opaqueIdSchema.safeParse(value).success) {
    throw new Error("invalid opaque identifier");
  }
}

function parseRequest(row: RequestRow): ScanRequestRecord {
  assertOpaqueId(row.request_id);
  if (
    (row.github_account_id !== null &&
      !safeNonNegativeInteger(row.github_account_id)) ||
    !githubLoginSchema.safeParse(row.username).success ||
    !scanRequestStateSchema.safeParse(row.state).success ||
    (row.reason !== null && !failureClassSchema.safeParse(row.reason).success) ||
    ![0, 1].includes(row.discovery_complete) ||
    !["ai_not_run", "ai_waiting", "ai_partial"].includes(row.ai_lane) ||
    !safeNonNegativeInteger(row.created_at_ms) ||
    !safeNonNegativeInteger(row.updated_at_ms)
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

function parseReasons(value: string): SpecialistReasons {
  try {
    const parsed = specialistReasonsSchema.parse(JSON.parse(value) as unknown);
    return Object.fromEntries(
      SCAN_ENGINES.flatMap((engine) =>
        parsed[engine] === undefined ? [] : [[engine, parsed[engine]]],
      ),
    );
  } catch {
    throw new Error("invalid specialist reasons");
  }
}

function serializeReasons(value: SpecialistReasons): string {
  const parsed = specialistReasonsSchema.parse(value);
  return JSON.stringify(
    Object.fromEntries(
      SCAN_ENGINES.flatMap((engine) =>
        parsed[engine] === undefined ? [] : [[engine, parsed[engine]]],
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

function serializeCoverage(value: SpecialistProgress): string {
  return JSON.stringify(repositoryCoverageSchema.parse(value));
}

function parseRepository(row: RepositoryRow): RepositoryRecord {
  assertOpaqueId(row.request_id);
  if (
    !safeNonNegativeInteger(row.repository_id) ||
    !githubRepoNameSchema.safeParse(row.name).success ||
    ![0, 1].includes(row.is_fork) ||
    (row.commit_sha !== null && !commitShaSchema.safeParse(row.commit_sha).success) ||
    !repositoryStateSchema.safeParse(row.state).success ||
    (row.reason !== null && !failureClassSchema.safeParse(row.reason).success) ||
    !safeNonNegativeInteger(row.attempt_count) ||
    !safeNonNegativeInteger(row.lease_generation) ||
    !safeNonNegativeInteger(row.discovered_at_ms) ||
    !safeNonNegativeInteger(row.updated_at_ms)
  ) {
    throw new Error("invalid repository row");
  }
  if (row.lease_owner !== null) assertOpaqueId(row.lease_owner);
  if (
    (row.lease_owner === null) !== (row.lease_expires_at_ms === null) ||
    (row.lease_expires_at_ms !== null &&
      !safeNonNegativeInteger(row.lease_expires_at_ms)) ||
    (row.published_lease_generation !== null &&
      (!safeNonNegativeInteger(row.published_lease_generation) ||
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
    specialistReasons: parseReasons(row.specialist_reasons),
    attemptCount: row.attempt_count,
    leaseGeneration: row.lease_generation,
    lease,
    publishedLeaseGeneration: row.published_lease_generation,
    discoveredAtMs: row.discovered_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function parseFinding(row: FindingRow): BrokerDerivedFinding {
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
    // Absent on every finding stored before locations were published, so the
    // key is omitted rather than set to undefined: the schema is strict.
    ...(row.locations_json === null
      ? {}
      : { locations: JSON.parse(row.locations_json) as unknown }),
  });
  if (!parsed.success) throw new Error("invalid finding row");
  return parsed.data;
}

function sameFinding(left: BrokerDerivedFinding, right: BrokerDerivedFinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findingChunks(
  findings: readonly BrokerDerivedFinding[],
): readonly (readonly [number, string, string, number, readonly BrokerDerivedFinding[]])[] {
  const ordered = [...findings].toSorted((left, right) =>
    left.finding_id.localeCompare(right.finding_id),
  );
  const chunks: Array<
    readonly [number, string, string, number, readonly BrokerDerivedFinding[]]
  > = [];
  for (let offset = 0; offset < ordered.length; offset += FINDINGS_PER_CHUNK) {
    const values = ordered.slice(offset, offset + FINDINGS_PER_CHUNK);
    const first = values[0];
    const last = values.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("invalid finding chunk");
    }
    chunks.push([
      Math.floor(offset / FINDINGS_PER_CHUNK),
      first.finding_id,
      last.finding_id,
      values.length,
      values,
    ]);
  }
  return chunks;
}

function uniformCoverage(state: "waiting" | "not_applicable"): SpecialistProgress {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [specialist, state]),
  ) as SpecialistProgress;
}

function totalsForDiscovery(
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

function serializeTotals(totals: RequestTotals): readonly [string, string] {
  return [
    JSON.stringify(repositoryStateTotalsSchema.parse(totals.repositoryTotals)),
    JSON.stringify(coverageTotalsSchema.parse(totals.coverageTotals)),
  ];
}

function statement(
  database: D1Database,
  sql: string,
  values: readonly D1Value[] = [],
): D1PreparedStatement {
  return database.prepare(sql).bind(...values);
}

function returned<T>(result: { readonly success: boolean; readonly results: T[] }): T[] {
  if (!result.success) throw new Error("D1 operation failed");
  return result.results;
}

export class D1Store implements Store {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async createRequest(input: CreateRequestInput): Promise<ScanRequestRecord> {
    this.#validateCreate(input);
    const [repositoryTotals, coverageTotals] = serializeTotals(emptyRequestTotals());
    try {
      const results = await this.#database.batch([
        statement(
          this.#database,
          `INSERT INTO scan_requests(
             request_id, github_account_id, username, state, reason,
             discovery_complete, ai_lane, created_at_ms, updated_at_ms
           ) VALUES (?, NULL, ?, 'accepted', NULL, 0, 'ai_not_run', ?, ?)
           RETURNING request_id`,
          [input.requestId, input.username, input.nowMs, input.nowMs],
        ),
        statement(
          this.#database,
          `INSERT INTO request_totals(
             request_id, repository_totals, coverage_totals
           ) VALUES (?, ?, ?)`,
          [input.requestId, repositoryTotals, coverageTotals],
        ),
        statement(
          this.#database,
          `INSERT INTO write_reservations(
             request_id, stage, utc_day, modeled_writes
           ) VALUES (?, 'request', ?, ?)`,
          [input.requestId, utcDay(input.nowMs), MODELED_REQUEST_WRITES],
        ),
      ]);
      if (returned(results[0] ?? { success: false, results: [] }).length !== 1) {
        throw new Error("request creation failed");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("D1_WRITE_RESERVE")) {
        throw new StoreWriteReserveError();
      }
      throw new Error("request creation failed");
    }
    const created = await this.getRequest(input.requestId);
    if (created === null) throw new Error("request creation failed");
    return created;
  }

  async startDiscovery(requestId: OpaqueId, nowMs: number): Promise<boolean> {
    assertOpaqueId(requestId);
    assertTime(nowMs);
    const result = await statement(
      this.#database,
      `UPDATE scan_requests SET state = 'discovering', updated_at_ms = ?
       WHERE request_id = ? AND discovery_complete = 0
         AND state IN ('accepted','discovering') RETURNING 1 AS changed`,
      [nowMs, requestId],
    ).all<{ changed: number }>();
    return returned(result).length === 1;
  }

  async completeDiscovery(
    input: CompleteDiscoveryInput,
  ): Promise<DiscoveryCompletionResult> {
    this.#validateDiscovery(input);
    const request = await this.getRequest(input.requestId);
    if (request === null || request.state === "failed") return "invalid_state";
    if (request.discoveryComplete) {
      return (await this.#discoveryMatches(input)) ? "idempotent" : "conflict";
    }
    if (!["accepted", "discovering"].includes(request.state)) return "invalid_state";

    const ledger = input.repositories.map((repository) => [
      repository.repositoryId,
      repository.name,
      repository.isFork ? 1 : 0,
      repository.commitSha,
      repository.commitSha === null ? "empty" : "waiting",
      uniformCoverage(
        repository.commitSha === null ? "not_applicable" : "waiting",
      ),
    ]);
    const ledgerJson = JSON.stringify(ledger);
    if (textEncoder.encode(ledgerJson).byteLength > MAX_DISCOVERY_JSON_BYTES) {
      throw new Error("discovery completion failed");
    }
    const modeledWrites =
      MODELED_DISCOVERY_WRITES +
      input.repositories.length * MODELED_WRITES_PER_REPOSITORY;
    if (!safeNonNegativeInteger(modeledWrites)) {
      throw new StoreWriteReserveError();
    }
    const totals = totalsForDiscovery(input.repositories);
    const [repositoryTotals, coverageTotals] = serializeTotals(totals);
    const completeImmediately = input.repositories.every(
      (repository) => repository.commitSha === null,
    );
    try {
      const results = await this.#database.batch([
        statement(
          this.#database,
          `INSERT INTO write_reservations(
             request_id, stage, utc_day, modeled_writes
           )
           SELECT ?, 'discovery', ?, ? WHERE EXISTS (
             SELECT 1 FROM scan_requests WHERE request_id = ?
               AND discovery_complete = 0 AND state IN ('accepted','discovering')
           ) AND NOT EXISTS (
             SELECT 1 FROM write_reservations
             WHERE request_id = ? AND stage = 'discovery'
           )`,
          [
            input.requestId,
            utcDay(input.nowMs),
            modeledWrites,
            input.requestId,
            input.requestId,
          ],
        ),
        statement(
          this.#database,
          `INSERT INTO repositories(
             request_id, repository_id, name, is_fork, commit_sha, state, reason,
             attempt_count, lease_owner, lease_generation, lease_expires_at_ms,
             published_lease_generation, discovered_at_ms, updated_at_ms,
             specialist_reasons, coverage_json
           )
           SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
             json_extract(value, '$[2]'), json_extract(value, '$[3]'),
             json_extract(value, '$[4]'), NULL, 0, NULL, 0, NULL, NULL, ?, ?,
             '{}', json(json_extract(value, '$[5]'))
           FROM json_each(?)
           WHERE EXISTS (
             SELECT 1 FROM scan_requests WHERE request_id = ?
               AND discovery_complete = 0 AND state IN ('accepted','discovering')
           )`,
          [
            input.requestId,
            input.nowMs,
            input.nowMs,
            ledgerJson,
            input.requestId,
          ],
        ),
        statement(
          this.#database,
          `UPDATE request_totals
           SET repository_totals = ?, coverage_totals = ?
           WHERE request_id = ? AND EXISTS (
             SELECT 1 FROM scan_requests WHERE request_id = ?
               AND discovery_complete = 0 AND state IN ('accepted','discovering')
           ) RETURNING 1 AS changed`,
          [repositoryTotals, coverageTotals, input.requestId, input.requestId],
        ),
        statement(
          this.#database,
          `UPDATE scan_requests
           SET github_account_id = ?, username = ?, state = ?, reason = NULL,
               discovery_complete = 1, updated_at_ms = ?
           WHERE request_id = ? AND discovery_complete = 0
             AND state IN ('accepted','discovering') RETURNING 1 AS changed`,
          [
            input.githubAccountId,
            input.canonicalLogin,
            completeImmediately ? "complete" : "scanning",
            input.nowMs,
            input.requestId,
          ],
        ),
      ]);
      if (returned(results[3] ?? { success: false, results: [] }).length === 1) {
        return "completed";
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("D1_WRITE_RESERVE")) {
        throw new StoreWriteReserveError();
      }
      throw new Error("discovery completion failed");
    }
    const current = await this.getRequest(input.requestId);
    return current?.discoveryComplete === true && (await this.#discoveryMatches(input))
      ? "idempotent"
      : "conflict";
  }

  async failRequest(input: FailRequestInput): Promise<boolean> {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (!failureClassSchema.safeParse(input.reason).success) {
      throw new Error("invalid request failure");
    }
    const result = await statement(
      this.#database,
      `UPDATE scan_requests SET state = 'failed', reason = ?, updated_at_ms = ?
       WHERE request_id = ? AND discovery_complete = 0
         AND state IN ('accepted','discovering') RETURNING 1 AS changed`,
      [input.reason, input.nowMs, input.requestId],
    ).all();
    return returned(result).length === 1;
  }

  async getRequest(requestId: OpaqueId): Promise<ScanRequestRecord | null> {
    assertOpaqueId(requestId);
    const row = await statement(
      this.#database,
      "SELECT * FROM scan_requests WHERE request_id = ?",
      [requestId],
    ).first<RequestRow>();
    return row === null ? null : parseRequest(row);
  }

  async getRequestTotals(requestId: OpaqueId): Promise<RequestTotals | null> {
    assertOpaqueId(requestId);
    const row = await statement(
      this.#database,
      `SELECT t.repository_totals, t.coverage_totals
       FROM request_totals t INNER JOIN scan_requests r USING(request_id)
       WHERE t.request_id = ?`,
      [requestId],
    ).first<{ repository_totals: string; coverage_totals: string }>();
    if (row === null) return null;
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

  async findActiveRequestByUsername(
    username: GithubLogin,
  ): Promise<ScanRequestRecord | null> {
    if (!githubLoginSchema.safeParse(username).success) {
      throw new Error("invalid GitHub username");
    }
    const row = await statement(
      this.#database,
      `SELECT * FROM scan_requests WHERE lower(username) = lower(?)
         AND state IN ('accepted','discovering','scanning')
       ORDER BY created_at_ms ASC LIMIT 1`,
      [username],
    ).first<RequestRow>();
    return row === null ? null : parseRequest(row);
  }

  async listPendingDiscoveryRequests(
    limit: number,
  ): Promise<readonly ScanRequestRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("invalid pending-discovery limit");
    }
    const result = await statement(
      this.#database,
      `SELECT * FROM scan_requests WHERE discovery_complete = 0
         AND state IN ('accepted','discovering')
       ORDER BY created_at_ms ASC, request_id ASC LIMIT ?`,
      [limit],
    ).all<RequestRow>();
    return returned(result).map(parseRequest);
  }

  async listRepositories(input: RepositoryPageInput): Promise<RepositoryPageRecord> {
    this.#validateRepositoryPage(input);
    const result = await statement(
      this.#database,
      `SELECT repositories.* FROM repositories
       INNER JOIN scan_requests USING(request_id)
       WHERE repositories.request_id = ? AND repository_id > ?
         AND scan_requests.discovery_complete = 1
       ORDER BY repository_id ASC LIMIT ?`,
      [input.requestId, input.afterRepositoryId ?? -1, input.limit + 1],
    ).all<RepositoryRow>();
    const rows = returned(result);
    const hasNext = rows.length > input.limit;
    const repositories = (hasNext ? rows.slice(0, input.limit) : rows).map(
      parseRepository,
    );
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
    const result = await statement(
      this.#database,
      `SELECT * FROM (
         SELECT
           json_extract(entry.value, '$.finding_id') AS finding_id,
           json_extract(entry.value, '$.request_id') AS request_id,
           json_extract(entry.value, '$.repository_id') AS repository_id,
           json_extract(entry.value, '$.commit_sha') AS commit_sha,
           json_extract(entry.value, '$.engine') AS engine,
           json_extract(entry.value, '$.rule_id') AS rule_id,
           json_extract(entry.value, '$.category') AS category,
           json_extract(entry.value, '$.severity') AS severity,
           json_extract(entry.value, '$.confidence') AS confidence,
           json_extract(entry.value, '$.occurrence_bucket') AS occurrence_bucket,
           json_extract(entry.value, '$.remediation_key') AS remediation_key,
           json_extract(entry.value, '$.owner_detail_ref') AS owner_detail_ref,
           json_extract(entry.value, '$.locations') AS locations_json
         FROM finding_chunks, json_each(finding_chunks.findings_json) AS entry
         WHERE finding_chunks.request_id = ?
       ) WHERE finding_id > ? ORDER BY finding_id ASC LIMIT ?`,
      [input.requestId, input.afterFindingId ?? "", input.limit + 1],
    ).all<FindingRow>();
    const rows = returned(result);
    const hasNext = rows.length > input.limit;
    const findings = (hasNext ? rows.slice(0, input.limit) : rows).map(parseFinding);
    return {
      findings,
      nextFindingId:
        hasNext && findings.length > 0
          ? findings.at(-1)?.finding_id ?? null
          : null,
    };
  }

  async claimNext(input: ClaimInput): Promise<RepositoryRecord | null> {
    return this.#claim(input, false);
  }

  async claimNextForWorker(input: ClaimInput): Promise<RepositoryRecord | null> {
    return this.#claim(input, true);
  }

  async #claim(
    input: ClaimInput,
    oneActiveLease: boolean,
  ): Promise<RepositoryRecord | null> {
    assertOpaqueId(input.workerId);
    assertTime(input.nowMs);
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error("invalid lease duration");
    }
    const expiresAtMs = input.nowMs + input.leaseDurationMs;
    assertTime(expiresAtMs);
    const result = await statement(
      this.#database,
      `WITH candidate AS (
         SELECT repositories.request_id, repositories.repository_id
         FROM repositories INNER JOIN scan_requests
           ON scan_requests.request_id = repositories.request_id
         WHERE repositories.state = 'waiting'
           AND repositories.lease_owner IS NULL
           AND repositories.attempt_count < ${MAX_LEASE_ATTEMPTS}
           AND scan_requests.state = 'scanning'
           ${oneActiveLease ? "AND NOT EXISTS (SELECT 1 FROM repositories active WHERE active.lease_owner = ? AND active.lease_expires_at_ms > ?)" : ""}
         ORDER BY repositories.attempt_count ASC,
                  repositories.repository_id ASC,
                  repositories.request_id ASC LIMIT 1
       )
       UPDATE repositories SET state = 'leased', lease_owner = ?,
         lease_generation = lease_generation + 1, lease_expires_at_ms = ?,
         attempt_count = attempt_count + 1, updated_at_ms = ?
       WHERE state = 'waiting' AND lease_owner IS NULL
         AND EXISTS (SELECT 1 FROM candidate
           WHERE candidate.request_id = repositories.request_id
             AND candidate.repository_id = repositories.repository_id)
       RETURNING *`,
      oneActiveLease
        ? [
            input.workerId,
            input.nowMs,
            input.workerId,
            expiresAtMs,
            input.nowMs,
          ]
        : [input.workerId, expiresAtMs, input.nowMs],
    ).all<RepositoryRow>();
    const rows = returned(result);
    return rows[0] === undefined ? null : parseRepository(rows[0]);
  }

  async heartbeat(input: HeartbeatInput): Promise<boolean> {
    this.#validateLease(input);
    assertTime(input.nowMs);
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error("invalid lease duration");
    }
    const expiresAtMs = input.nowMs + input.leaseDurationMs;
    assertTime(expiresAtMs);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const result = await statement(
      this.#database,
      `UPDATE repositories SET lease_expires_at_ms = ?, updated_at_ms = ?
       WHERE request_id = ? AND repository_id = ? AND lease_owner = ?
         AND lease_generation = ? AND lease_expires_at_ms > ?
         AND state IN (${placeholders}) RETURNING 1 AS changed`,
      [
        expiresAtMs,
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.workerId,
        input.generation,
        input.nowMs,
        ...LEASED_REPOSITORY_STATES,
      ],
    ).all();
    return returned(result).length === 1;
  }

  async classifyExpiredLeases(nowMs: number): Promise<ExpiredLeaseResult> {
    return this.classifyExpiredLeasesForWorker(nowMs, null);
  }

  async classifyExpiredLeasesForWorker(
    nowMs: number,
    workerId: OpaqueId | null,
  ): Promise<ExpiredLeaseResult> {
    assertTime(nowMs);
    if (workerId !== null) assertOpaqueId(workerId);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const result = await statement(
      this.#database,
      `SELECT request_id, repository_id, attempt_count, lease_generation
       FROM repositories WHERE lease_expires_at_ms IS NOT NULL
         AND lease_expires_at_ms <= ? AND state IN (${placeholders})
         ${workerId === null ? "" : "AND lease_owner = ?"}
       ORDER BY lease_expires_at_ms, request_id, repository_id
       LIMIT ${MAX_EXPIRED_PER_PASS}`,
      [
        nowMs,
        ...LEASED_REPOSITORY_STATES,
        ...(workerId === null ? [] : [workerId]),
      ],
    ).all<{
      request_id: string;
      repository_id: number;
      attempt_count: number;
      lease_generation: number;
    }>();
    const retryable: ExhaustedLeaseRef[] = [];
    const exhausted: ExhaustedLeaseRef[] = [];
    for (const row of returned(result)) {
      assertOpaqueId(row.request_id);
      (row.attempt_count >= MAX_LEASE_ATTEMPTS ? exhausted : retryable).push({
        requestId: row.request_id,
        repositoryId: row.repository_id,
        generation: row.lease_generation,
      });
    }
    return { retryable, exhausted };
  }

  async requeueCleaned(input: FinalizeExhaustedInput): Promise<boolean> {
    return this.requeueCleanedForWorker(input, null);
  }

  async requeueCleanedForWorker(
    input: FinalizeExhaustedInput,
    workerId: OpaqueId | null,
  ): Promise<boolean> {
    this.#validateExpired(input);
    if (workerId !== null) assertOpaqueId(workerId);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const result = await statement(
      this.#database,
      `UPDATE repositories SET state = 'waiting', reason = NULL,
         specialist_reasons = '{}', lease_owner = NULL,
         lease_expires_at_ms = NULL, updated_at_ms = ?
       WHERE request_id = ? AND repository_id = ? AND lease_generation = ?
         AND attempt_count < ? AND lease_expires_at_ms IS NOT NULL
         AND lease_expires_at_ms <= ? AND published_lease_generation IS NULL
         AND state IN (${placeholders})
         ${workerId === null ? "" : "AND lease_owner = ?"}
       RETURNING 1 AS changed`,
      [
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.generation,
        MAX_LEASE_ATTEMPTS,
        input.nowMs,
        ...LEASED_REPOSITORY_STATES,
        ...(workerId === null ? [] : [workerId]),
      ],
    ).all();
    return returned(result).length === 1;
  }

  async finalizeExhausted(input: FinalizeExhaustedInput): Promise<boolean> {
    return this.finalizeExhaustedForWorker(input, null);
  }

  async finalizeExhaustedForWorker(
    input: FinalizeExhaustedInput,
    workerId: OpaqueId | null,
  ): Promise<boolean> {
    this.#validateExpired(input);
    if (workerId !== null) assertOpaqueId(workerId);
    const placeholders = LEASED_REPOSITORY_STATES.map(() => "?").join(",");
    const failedCoverage = `json_object(${SPECIALISTS.flatMap((specialist) => [
      `'${specialist}'`,
      `CASE WHEN json_extract(coverage_json, '$.${specialist}') = 'waiting' THEN 'failed' ELSE json_extract(coverage_json, '$.${specialist}') END`,
    ]).join(",")})`;
    const results = await this.#database.batch([
      statement(
        this.#database,
        `UPDATE repositories SET state = 'failed',
           reason = 'LEASE_RETRY_EXHAUSTED', specialist_reasons = '{}',
           coverage_json = ${failedCoverage}, lease_owner = NULL,
           lease_expires_at_ms = NULL, updated_at_ms = ?
         WHERE request_id = ? AND repository_id = ? AND lease_generation = ?
           AND attempt_count >= ? AND lease_expires_at_ms IS NOT NULL
           AND lease_expires_at_ms <= ? AND published_lease_generation IS NULL
           AND state IN (${placeholders})
           ${workerId === null ? "" : "AND lease_owner = ?"}
         RETURNING 1 AS changed`,
        [
          input.nowMs,
          input.requestId,
          input.repositoryId,
          input.generation,
          MAX_LEASE_ATTEMPTS,
          input.nowMs,
          ...LEASED_REPOSITORY_STATES,
          ...(workerId === null ? [] : [workerId]),
        ],
      ),
      this.#refreshRequestStatement(
        input.requestId,
        input.nowMs,
        `EXISTS (
          SELECT 1 FROM repositories WHERE request_id = ? AND repository_id = ?
            AND state = 'failed' AND reason = 'LEASE_RETRY_EXHAUSTED'
            AND lease_generation = ? AND updated_at_ms = ?
        )`,
        [input.requestId, input.repositoryId, input.generation, input.nowMs],
      ),
    ]);
    return returned(results[0] ?? { success: false, results: [] }).length === 1;
  }

  async release(input: ReleaseInput): Promise<boolean> {
    this.#validateLease(input);
    assertTime(input.nowMs);
    const result = await statement(
      this.#database,
      `UPDATE repositories SET state = 'waiting', reason = NULL,
         specialist_reasons = '{}', lease_owner = NULL,
         lease_expires_at_ms = NULL, updated_at_ms = ?
       WHERE request_id = ? AND repository_id = ? AND state = 'leased'
         AND lease_owner = ? AND lease_generation = ?
         AND lease_expires_at_ms > ? AND attempt_count < ?
       RETURNING 1 AS changed`,
      [
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.workerId,
        input.generation,
        input.nowMs,
        MAX_LEASE_ATTEMPTS,
      ],
    ).all();
    return returned(result).length === 1;
  }

  async retryCleaned(input: ReleaseInput): Promise<boolean> {
    this.#validateLease(input);
    assertTime(input.nowMs);
    const result = await statement(
      this.#database,
      `UPDATE repositories SET state = 'waiting', reason = NULL,
         specialist_reasons = '{}', lease_owner = NULL,
         lease_expires_at_ms = NULL, updated_at_ms = ?
       WHERE request_id = ? AND repository_id = ? AND state = 'cleaning'
         AND lease_owner = ? AND lease_generation = ?
         AND lease_expires_at_ms > ? AND published_lease_generation IS NULL
         AND attempt_count < ? RETURNING 1 AS changed`,
      [
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.workerId,
        input.generation,
        input.nowMs,
        MAX_LEASE_ATTEMPTS,
      ],
    ).all();
    return returned(result).length === 1;
  }

  async transition(input: TransitionInput): Promise<boolean> {
    this.#validateLease(input);
    assertTime(input.nowMs);
    if (!canTransition(input.expectedState, input.nextState)) return false;
    const result = await statement(
      this.#database,
      `UPDATE repositories SET state = ?, updated_at_ms = ?
       WHERE request_id = ? AND repository_id = ? AND state = ?
         AND lease_owner = ? AND lease_generation = ?
         AND lease_expires_at_ms > ? RETURNING 1 AS changed`,
      [
        input.nextState,
        input.nowMs,
        input.requestId,
        input.repositoryId,
        input.expectedState,
        input.workerId,
        input.generation,
        input.nowMs,
      ],
    ).all();
    return returned(result).length === 1;
  }

  async publish(input: PublishInput): Promise<PublicationResult> {
    validatePublishInput(input);
    const reasons = serializeReasons(input.specialistReasons);
    const coverage = serializeCoverage(input.coverage);
    const classification = await this.#classifyPublication(input, reasons, coverage);
    if (typeof classification === "string") return classification;
    const observedState = classification.observedState;
    const chunksJson = JSON.stringify(findingChunks(input.findings));
    try {
      const results = await this.#database.batch([
        statement(
          this.#database,
          `INSERT INTO finding_chunks(
             request_id, repository_id, chunk_index, first_finding_id,
             last_finding_id, finding_count, findings_json
           )
           SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
             json_extract(value, '$[2]'), json_extract(value, '$[3]'),
             json(json_extract(value, '$[4]'))
           FROM json_each(?) WHERE EXISTS (
             SELECT 1 FROM repositories WHERE request_id = ? AND repository_id = ?
               AND state = ? AND lease_owner = ?
               AND lease_generation = ? AND lease_expires_at_ms > ?
               AND published_lease_generation IS NULL
           )`,
          [
            input.requestId,
            input.repositoryId,
            chunksJson,
            input.requestId,
            input.repositoryId,
            observedState,
            input.workerId,
            input.generation,
            input.nowMs,
          ],
        ),
        statement(
          this.#database,
          `UPDATE repositories SET state = ?, reason = ?, specialist_reasons = ?,
             coverage_json = ?, published_lease_generation = ?, lease_owner = NULL,
             lease_expires_at_ms = NULL, updated_at_ms = ?
           WHERE request_id = ? AND repository_id = ?
             AND state = ? AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at_ms > ?
             AND published_lease_generation IS NULL RETURNING 1 AS changed`,
          [
            input.terminalState,
            input.reason,
            reasons,
            coverage,
            input.generation,
            input.nowMs,
            input.requestId,
            input.repositoryId,
            observedState,
            input.workerId,
            input.generation,
            input.nowMs,
          ],
        ),
        this.#refreshRequestStatement(
          input.requestId,
          input.nowMs,
          `EXISTS (
            SELECT 1 FROM repositories WHERE request_id = ? AND repository_id = ?
              AND published_lease_generation = ? AND updated_at_ms = ?
          )`,
          [input.requestId, input.repositoryId, input.generation, input.nowMs],
        ),
      ]);
      if (returned(results[1] ?? { success: false, results: [] }).length === 1) {
        return "published";
      }
    } catch {
      throw new Error("publication transaction failed");
    }
    const retry = await this.#classifyPublication(input, reasons, coverage);
    return typeof retry === "string" ? retry : "stale_lease";
  }

  async #classifyPublication(
    input: PublishInput,
    reasons: string,
    coverage: string,
  ): Promise<PublicationResult | { readonly observedState: RepositoryState }> {
    const row = await statement(
      this.#database,
      "SELECT * FROM repositories WHERE request_id = ? AND repository_id = ?",
      [input.requestId, input.repositoryId],
    ).first<RepositoryRow>();
    if (row === null) return "stale_lease";
    if (
      row.commit_sha === null ||
      input.findings.some((finding) => finding.commit_sha !== row.commit_sha)
    ) {
      throw new Error("finding commit mismatch");
    }
    if (row.published_lease_generation !== null) {
      if (row.published_lease_generation !== input.generation) {
        return "idempotency_conflict";
      }
      const same =
        row.state === input.terminalState &&
        row.reason === input.reason &&
        row.specialist_reasons === reasons &&
        row.coverage_json === coverage &&
        (await this.#publicationFindingsMatch(input));
      return same ? "idempotent" : "idempotency_conflict";
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
    return { observedState: row.state as RepositoryState };
  }

  async #publicationFindingsMatch(input: PublishInput): Promise<boolean> {
    const result = await statement(
      this.#database,
      `SELECT findings_json FROM finding_chunks
       WHERE request_id = ? AND repository_id = ? ORDER BY chunk_index`,
      [input.requestId, input.repositoryId],
    ).all<FindingChunkRow>();
    const current: BrokerDerivedFinding[] = [];
    try {
      for (const row of returned(result)) {
        const values = JSON.parse(row.findings_json) as unknown;
        if (!Array.isArray(values)) return false;
        for (const value of values) {
          current.push(brokerDerivedFindingSchema.parse(value));
        }
      }
    } catch {
      throw new Error("invalid finding chunks");
    }
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

  #refreshRequestStatement(
    requestId: OpaqueId,
    nowMs: number,
    guardSql: string,
    guardValues: readonly D1Value[],
  ): D1PreparedStatement {
    return statement(
      this.#database,
      `UPDATE scan_requests SET state = CASE WHEN NOT EXISTS (
         SELECT 1 FROM repositories
         WHERE repositories.request_id = scan_requests.request_id
           AND repositories.state NOT IN ('complete','empty','partial','failed','cancelled')
       ) THEN 'complete' ELSE 'scanning' END, updated_at_ms = ?
       WHERE request_id = ? AND discovery_complete = 1 AND ${guardSql}`,
      [nowMs, requestId, ...guardValues],
    );
  }

  async #discoveryMatches(input: CompleteDiscoveryInput): Promise<boolean> {
    const request = await this.getRequest(input.requestId);
    return (
      request?.githubAccountId === input.githubAccountId &&
      request.username === input.canonicalLogin &&
      (await this.#discoveryMatchesRepositories(input))
    );
  }

  async #discoveryMatchesRepositories(
    input: CompleteDiscoveryInput,
  ): Promise<boolean> {
    const result = await statement(
      this.#database,
      `SELECT repository_id, name, is_fork, commit_sha FROM repositories
       WHERE request_id = ? ORDER BY repository_id`,
      [input.requestId],
    ).all<{
      repository_id: number;
      name: string;
      is_fork: number;
      commit_sha: string | null;
    }>();
    const rows = returned(result);
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

  #validateCreate(input: CreateRequestInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (!githubLoginSchema.safeParse(input.username).success) {
      throw new Error("invalid request input");
    }
  }

  #validateDiscovery(input: CompleteDiscoveryInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (
      !safeNonNegativeInteger(input.githubAccountId) ||
      !githubLoginSchema.safeParse(input.canonicalLogin).success
    ) {
      throw new Error("invalid discovered account");
    }
    const ids = new Set<number>();
    for (const repository of input.repositories) {
      if (
        !safeNonNegativeInteger(repository.repositoryId) ||
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

  #validateRepositoryPage(input: RepositoryPageInput): void {
    assertOpaqueId(input.requestId);
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.afterRepositoryId !== null &&
        !safeNonNegativeInteger(input.afterRepositoryId))
    ) {
      throw new Error("invalid repository page");
    }
  }

  #validateLease(input: {
    requestId: OpaqueId;
    repositoryId: number;
    workerId: OpaqueId;
    generation: number;
  }): void {
    assertOpaqueId(input.requestId);
    assertOpaqueId(input.workerId);
    if (
      !safeNonNegativeInteger(input.repositoryId) ||
      !safeNonNegativeInteger(input.generation) ||
      input.generation === 0
    ) {
      throw new Error("invalid lease reference");
    }
  }

  #validateExpired(input: FinalizeExhaustedInput): void {
    assertOpaqueId(input.requestId);
    assertTime(input.nowMs);
    if (
      !safeNonNegativeInteger(input.repositoryId) ||
      !safeNonNegativeInteger(input.generation) ||
      input.generation === 0
    ) {
      throw new Error("invalid expired lease reference");
    }
  }
}
