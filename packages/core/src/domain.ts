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
  Specialist,
  SpecialistCoverageOutcome,
  SpecialistProgressState,
  BrokerDerivedFinding,
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

export interface LeaseIdentity {
  readonly workerId: OpaqueId;
  readonly generation: number;
  readonly expiresAtMs: number;
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

export interface RequeueExpiredResult {
  /** Exact stale-generation scratch roots to remove after rows are requeued. */
  readonly requeued: readonly ExhaustedLeaseRef[];
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
  findActiveRequestByUsername(username: GithubLogin): Promise<ScanRequestRecord | null>;
  listRepositories(input: RepositoryPageInput): Promise<RepositoryPageRecord>;
  listFindings(input: FindingPageInput): Promise<FindingPageRecord>;
  claimNext(input: ClaimInput): Promise<RepositoryRecord | null>;
  heartbeat(input: HeartbeatInput): Promise<boolean>;
  requeueExpiredLeases(nowMs: number): Promise<RequeueExpiredResult>;
  /** Called only after the janitor removed the exact generation's scratch root. */
  finalizeExhausted(input: FinalizeExhaustedInput): Promise<boolean>;
  release(input: ReleaseInput): Promise<boolean>;
  transition(input: TransitionInput): Promise<boolean>;
  publish(input: PublishInput): Promise<PublicationResult>;
}
