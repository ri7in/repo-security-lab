import {
  REPOSITORY_ACTIVE_STATES,
  REPOSITORY_STATES,
  type RepositoryState,
} from "@app/contracts";

const transitions = {
  discovered: ["waiting", "empty", "failed", "cancelled"],
  waiting: ["leased", "cancelled"],
  leased: ["acquiring", "cancelled"],
  acquiring: ["guarding", "cleaning"],
  guarding: ["scanning", "cleaning"],
  scanning: ["normalizing", "cleaning"],
  normalizing: ["cleaning"],
  cleaning: ["uploading", "partial", "failed", "cancelled"],
  uploading: ["waiting_to_publish", "partial", "failed", "cancelled"],
  waiting_to_publish: ["complete", "partial", "failed", "cancelled"],
  complete: [],
  empty: [],
  partial: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<RepositoryState, readonly RepositoryState[]>;

export const REPOSITORY_TRANSITIONS: Readonly<
  Record<RepositoryState, readonly RepositoryState[]>
> = transitions;

export const LEASED_REPOSITORY_STATES = [
  "leased",
  "acquiring",
  "guarding",
  "scanning",
  "normalizing",
  "cleaning",
  "uploading",
  "waiting_to_publish",
] as const;

export function canTransition(
  from: RepositoryState,
  to: RepositoryState,
): boolean {
  return REPOSITORY_TRANSITIONS[from].includes(to);
}

/**
 * Lease expiry is recovery, not an ordinary worker transition. Any active
 * leased pipeline state can be requeued, while unleased discovery/waiting
 * rows and terminal rows cannot. At the attempt ceiling the row parks in its
 * expired active state until a janitor cleans the generation-specific scratch
 * root; only then may Store.finalizeExhausted make it terminal.
 */
export function canRequeueExpiredLease(state: RepositoryState): boolean {
  return (LEASED_REPOSITORY_STATES as readonly RepositoryState[]).includes(
    state,
  );
}

export function assertCompleteStateGraph(): void {
  for (const state of REPOSITORY_STATES) {
    if (!(state in REPOSITORY_TRANSITIONS)) {
      throw new Error("incomplete repository state graph");
    }
  }
  for (const state of REPOSITORY_ACTIVE_STATES) {
    if (REPOSITORY_TRANSITIONS[state].length === 0) {
      throw new Error("active repository state has no exit");
    }
  }
}
