import type { DiscoveredRepository } from "./domain.js";

/**
 * Awards the request's deep-read slots to the repositories pushed to most
 * recently.
 *
 * Before this existed the AI lane read whichever repositories the queue
 * claimed first, and the claim order is repository id ascending, which on
 * GitHub means oldest first. A visitor's abandoned first project got the
 * model's attention while the code they push every week went unread.
 *
 * Forks and empty repositories never reach the AI lane, so they can never win
 * a slot. Among the rest, the most recent push wins; a repository GitHub gave
 * no push time for ranks behind every one it did; ties fall to the higher
 * repository id, which on GitHub is the more recently created repository.
 *
 * Every returned repository carries an explicit true or false, never an
 * absent mark: absence is reserved for rows written before this ranking
 * existed, which downstream reads as "behave the old way".
 */
export function markDeepReadEligible<T extends DiscoveredRepository>(
  repositories: readonly T[],
  limit: number,
): (T & { readonly aiEligible: boolean })[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("invalid deep-read limit");
  }
  const ranked = repositories
    .filter((repository) => !repository.isFork && repository.commitSha !== null)
    .toSorted((left, right) => {
      const leftPushed = left.pushedAtMs ?? null;
      const rightPushed = right.pushedAtMs ?? null;
      if (leftPushed !== rightPushed) {
        if (leftPushed === null) return 1;
        if (rightPushed === null) return -1;
        return rightPushed - leftPushed;
      }
      return right.repositoryId - left.repositoryId;
    });
  const winners = new Set(
    ranked.slice(0, limit).map((repository) => repository.repositoryId),
  );
  return repositories.map((repository) => ({
    ...repository,
    aiEligible: winners.has(repository.repositoryId),
  }));
}
