import type {
  AiLaneState,
  CommitSha,
  FailureClass,
  GithubLogin,
  GithubRepoName,
  OpaqueId,
  RepositoryActiveState,
  RepositoryState,
  RepositoryTerminalState,
  ScanRequestState,
  ScanEngine,
  Specialist,
  SpecialistCoverageOutcome,
  SpecialistProgressState,
  BrokerDerivedFinding,
  CoverageTotals,
  RepositoryStateTotals,
} from "@app/contracts";

export interface ScanRequestRecord {
  readonly schemaVersion: 1;
  readonly requestId: OpaqueId;
  /** Null until discovery atomically binds GitHub's immutable account id. */
  readonly githubAccountId: number | null;
  readonly username: GithubLogin;
  readonly state: ScanRequestState;
  readonly reason: FailureClass | null;
  readonly discoveryComplete: boolean;
  readonly aiLane: AiLaneState;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type SpecialistProgress = Readonly<Record<Specialist, SpecialistProgressState>>;
export type SpecialistOutcomes = Readonly<Record<Specialist, SpecialistCoverageOutcome>>;
/** Fixed, source-blind failure attribution for scan engines that actually ran. */
export type SpecialistReasons = Readonly<Partial<Record<ScanEngine, FailureClass>>>;

export interface LeaseIdentity {
  readonly workerId: OpaqueId;
  readonly generation: number;
  readonly expiresAtMs: number;
}

/** Closed retry budget shared by schedulers, stores, and workers. */
export const MAX_LEASE_ATTEMPTS = 3;

/** Fixed control-plane capacity signal; contains no database or target prose. */
export class StoreWriteReserveError extends Error {
  constructor() {
    super("D1_WRITE_RESERVE");
    this.name = "StoreWriteReserveError";
  }
}

export interface RepositoryRecord {
  readonly schemaVersion: 1;
  readonly requestId: OpaqueId;
  readonly repositoryId: number;
  readonly name: GithubRepoName;
  readonly isFork: boolean;
  readonly commitSha: CommitSha | null;
  readonly state: RepositoryState;
  readonly reason: FailureClass | null;
  readonly coverage: SpecialistProgress;
  readonly specialistReasons: SpecialistReasons;
  readonly attemptCount: number;
  /** Monotonic counter retained even while no lease is active (ABA guard). */
  readonly leaseGeneration: number;
  readonly lease: LeaseIdentity | null;
  readonly publishedLeaseGeneration: number | null;
  readonly discoveredAtMs: number;
  readonly updatedAtMs: number;
}

export interface DiscoveredRepository {
  readonly repositoryId: number;
  readonly name: GithubRepoName;
  readonly isFork: boolean;
  readonly commitSha: CommitSha | null;
}

export interface CreateRequestInput {
  readonly requestId: OpaqueId;
  readonly username: GithubLogin;
  readonly nowMs: number;
  /**
   * Two-letter country of the request, for the operator's usage log.
   *
   * Country only. The edge resolves it and hands over a code, so no address
   * ever reaches the application and none can be stored by mistake. Absent for
   * direct or unresolvable origins, which is a normal outcome, not an error.
   */
  readonly country?: string;
}

export interface CompleteDiscoveryInput {
  readonly requestId: OpaqueId;
  readonly githubAccountId: number;
  readonly canonicalLogin: GithubLogin;
  readonly repositories: readonly DiscoveredRepository[];
  readonly nowMs: number;
}

export interface FailRequestInput {
  readonly requestId: OpaqueId;
  readonly reason: FailureClass;
  readonly nowMs: number;
}

export const DISCOVERY_COMPLETION_RESULTS = [
  "completed",
  "idempotent",
  "conflict",
  "invalid_state",
] as const;
export type DiscoveryCompletionResult =
  (typeof DISCOVERY_COMPLETION_RESULTS)[number];

export interface LeaseRef {
  readonly requestId: OpaqueId;
  readonly repositoryId: number;
  readonly workerId: OpaqueId;
  readonly generation: number;
}

export interface ClaimInput {
  readonly workerId: OpaqueId;
  readonly nowMs: number;
  readonly leaseDurationMs: number;
}

export interface HeartbeatInput extends LeaseRef {
  readonly nowMs: number;
  readonly leaseDurationMs: number;
}

export interface TransitionInput extends LeaseRef {
  readonly expectedState: RepositoryActiveState;
  readonly nextState: RepositoryActiveState;
  readonly nowMs: number;
}

interface PublishInputBase extends LeaseRef {
  readonly coverage: SpecialistOutcomes;
  readonly specialistReasons: SpecialistReasons;
  readonly findings: readonly BrokerDerivedFinding[];
  readonly nowMs: number;
}

export type PublishInput = PublishInputBase &
  (
    | { readonly terminalState: "complete"; readonly reason: null }
    | {
        readonly terminalState: Exclude<RepositoryTerminalState, "complete" | "empty">;
        readonly reason: FailureClass;
      }
  );

export interface ReleaseInput extends LeaseRef {
  readonly nowMs: number;
}

export interface ExhaustedLeaseRef {
  readonly requestId: OpaqueId;
  readonly repositoryId: number;
  readonly generation: number;
}

export interface ExpiredLeaseResult {
  /** Exact stale generations parked until cleanup permits a retry. */
  readonly retryable: readonly ExhaustedLeaseRef[];
  /** Exact expired generations whose scratch roots require janitor proof. */
  readonly exhausted: readonly ExhaustedLeaseRef[];
}

export interface FinalizeExhaustedInput extends ExhaustedLeaseRef {
  readonly nowMs: number;
}

export const PUBLICATION_RESULTS = [
  "published",
  "idempotent",
  "stale_lease",
  "idempotency_conflict",
  "invalid_state",
] as const;
export type PublicationResult = (typeof PUBLICATION_RESULTS)[number];

export interface RepositoryPageInput {
  readonly requestId: OpaqueId;
  readonly afterRepositoryId: number | null;
  readonly limit: number;
}

export interface RepositoryPageRecord {
  readonly repositories: readonly RepositoryRecord[];
  readonly nextRepositoryId: number | null;
}

export interface FindingPageInput {
  readonly requestId: OpaqueId;
  readonly afterFindingId: OpaqueId | null;
  readonly limit: number;
}

export interface FindingPageRecord {
  readonly findings: readonly BrokerDerivedFinding[];
  readonly nextFindingId: OpaqueId | null;
}

export interface RequestAggregate {
  readonly request: ScanRequestRecord;
  readonly repositories: readonly RepositoryRecord[];
}

/** Source-blind materialized or SQL-derived totals for one complete ledger. */
export interface RequestTotals {
  readonly repositoryTotals: RepositoryStateTotals;
  readonly coverageTotals: CoverageTotals;
}

/**
 * Durable storage port shared by the local SQLite and future D1 adapters.
 * Every mutating worker method is lease-bound. Implementations return closed
 * result values and must never include database or target-controlled prose.
 */
export interface Store {
  createRequest(input: CreateRequestInput): Promise<ScanRequestRecord>;
  startDiscovery(requestId: OpaqueId, nowMs: number): Promise<boolean>;
  completeDiscovery(input: CompleteDiscoveryInput): Promise<DiscoveryCompletionResult>;
  failRequest(input: FailRequestInput): Promise<boolean>;
  getRequest(requestId: OpaqueId): Promise<ScanRequestRecord | null>;
  getRequestTotals(requestId: OpaqueId): Promise<RequestTotals | null>;
  findActiveRequestByUsername(username: GithubLogin): Promise<ScanRequestRecord | null>;
  /** Startup recovery for requests durably accepted before discovery finished. */
  listPendingDiscoveryRequests(limit: number): Promise<readonly ScanRequestRecord[]>;
  listRepositories(input: RepositoryPageInput): Promise<RepositoryPageRecord>;
  listFindings(input: FindingPageInput): Promise<FindingPageRecord>;
  claimNext(input: ClaimInput): Promise<RepositoryRecord | null>;
  heartbeat(input: HeartbeatInput): Promise<boolean>;
  /** Classifies expired rows without making any generation claimable. */
  classifyExpiredLeases(nowMs: number): Promise<ExpiredLeaseResult>;
  /** Requeues an exact expired generation only after its scratch root is gone. */
  requeueCleaned(input: FinalizeExhaustedInput): Promise<boolean>;
  /** Called only after the janitor removed the exact generation's scratch root. */
  finalizeExhausted(input: FinalizeExhaustedInput): Promise<boolean>;
  /** Voluntary pre-acquisition release; source-bearing states require cleanup. */
  release(input: ReleaseInput): Promise<boolean>;
  /** Live post-cleanup retry; only an exact unexpired cleaning lease may requeue. */
  retryCleaned(input: ReleaseInput): Promise<boolean>;
  transition(input: TransitionInput): Promise<boolean>;
  publish(input: PublishInput): Promise<PublicationResult>;
}

/** Minimal durable surface used by isolated pull workers. */
export type WorkerStorePort = Pick<
  Store,
  | "getRequest"
  | "claimNext"
  | "heartbeat"
  | "classifyExpiredLeases"
  | "requeueCleaned"
  | "finalizeExhausted"
  | "retryCleaned"
  | "transition"
  | "publish"
>;
