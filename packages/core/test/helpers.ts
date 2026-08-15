import {
  SPECIALISTS,
  type RepositoryState,
  type ScanRequestState,
  type SpecialistProgressState,
} from "@app/contracts";
import type {
  RepositoryRecord,
  ScanRequestRecord,
  SpecialistProgress,
} from "@app/core";

export function progress(
  state: SpecialistProgressState = "waiting",
): SpecialistProgress {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [specialist, state]),
  ) as SpecialistProgress;
}

export function repository(
  repositoryId: number,
  state: RepositoryState = "waiting",
  attemptCount = 0,
): RepositoryRecord {
  return {
    schemaVersion: 1,
    requestId: "req_0000000001",
    repositoryId,
    name: `repo-${repositoryId}`,
    isFork: false,
    commitSha: "a".repeat(40),
    state,
    reason: null,
    coverage: progress(),
    attemptCount,
    leaseGeneration: 0,
    lease: null,
    publishedLeaseGeneration: null,
    discoveredAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

export function request(
  state: ScanRequestState = "scanning",
  discoveryComplete = true,
): ScanRequestRecord {
  return {
    schemaVersion: 1,
    requestId: "req_0000000001",
    githubAccountId: 123,
    username: "ri7in",
    state,
    reason: null,
    discoveryComplete,
    aiLane: "ai_not_run",
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}
