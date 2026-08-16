import {
  REPOSITORY_STATES,
  SPECIALISTS,
  SPECIALIST_PROGRESS_STATES,
  isTerminalRepositoryState,
  type CoverageTotals,
  type RepositoryStateTotals,
  type ScanRequestState,
} from "@app/contracts";
import type { RepositoryRecord, ScanRequestRecord } from "./domain.js";

export interface LedgerAggregation {
  readonly requestState: ScanRequestState;
  readonly repositoryTotals: RepositoryStateTotals;
  readonly coverageTotals: CoverageTotals;
}

export function emptyRequestTotals(): Pick<
  LedgerAggregation,
  "repositoryTotals" | "coverageTotals"
> {
  return {
    repositoryTotals: Object.fromEntries(
      REPOSITORY_STATES.map((state) => [state, 0]),
    ) as RepositoryStateTotals,
    coverageTotals: Object.fromEntries(
      SPECIALISTS.map((specialist) => [
        specialist,
        Object.fromEntries(
          SPECIALIST_PROGRESS_STATES.map((state) => [state, 0]),
        ),
      ]),
    ) as CoverageTotals,
  };
}

export function deriveRequestState(
  request: ScanRequestRecord,
  repositories: readonly RepositoryRecord[],
): ScanRequestState {
  if (request.state === "failed") {
    return "failed";
  }
  if (!request.discoveryComplete) {
    return request.state === "accepted" ? "accepted" : "discovering";
  }
  return repositories.every((repository) =>
    isTerminalRepositoryState(repository.state),
  )
    ? "complete"
    : "scanning";
}

/** Requires the complete durable ledger, never one paginated API page. */
export function aggregateLedger(
  request: ScanRequestRecord,
  repositories: readonly RepositoryRecord[],
): LedgerAggregation {
  const { repositoryTotals, coverageTotals } = emptyRequestTotals();

  for (const repository of repositories) {
    repositoryTotals[repository.state] += 1;
    for (const specialist of SPECIALISTS) {
      coverageTotals[specialist][repository.coverage[specialist]] += 1;
    }
  }

  return {
    requestState: deriveRequestState(request, repositories),
    repositoryTotals,
    coverageTotals,
  };
}
