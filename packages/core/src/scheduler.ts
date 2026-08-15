import type { RepositoryRecord } from "./domain.js";

/**
 * Stable scheduling order: retry fewer-attempted work first, then the GitHub
 * repository id. No target-controlled name participates in the sort key.
 */
export function compareWaitingRepositories(
  left: RepositoryRecord,
  right: RepositoryRecord,
): number {
  const byAttempts = left.attemptCount - right.attemptCount;
  if (byAttempts !== 0) {
    return byAttempts;
  }
  return left.repositoryId - right.repositoryId;
}

export function orderWaitingRepositories(
  repositories: readonly RepositoryRecord[],
): RepositoryRecord[] {
  return repositories
    .filter((repository) => repository.state === "waiting")
    .toSorted(compareWaitingRepositories);
}
