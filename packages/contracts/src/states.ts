import { z } from "zod";

/**
 * Repository state machine vocabulary from the accepted orchestration
 * contract:
 * `discovered -> waiting -> leased -> acquiring -> guarding -> scanning ->
 *  normalizing -> cleaning -> uploading -> waiting_to_publish -> complete`
 * with terminal alternatives `empty | partial | failed | cancelled`.
 *
 * A repository with no default-branch OID is durably `empty`. No repository
 * disappears because a scanner or quota fails.
 */
export const REPOSITORY_ACTIVE_STATES = [
  "discovered",
  "waiting",
  "leased",
  "acquiring",
  "guarding",
  "scanning",
  "normalizing",
  "cleaning",
  "uploading",
  "waiting_to_publish",
] as const;
export type RepositoryActiveState = (typeof REPOSITORY_ACTIVE_STATES)[number];

export const REPOSITORY_TERMINAL_STATES = [
  "complete",
  "empty",
  "partial",
  "failed",
  "cancelled",
] as const;

export const REPOSITORY_STATES = [
  ...REPOSITORY_ACTIVE_STATES,
  ...REPOSITORY_TERMINAL_STATES,
] as const;

export const repositoryStateSchema = z.enum(REPOSITORY_STATES);
export type RepositoryState = z.infer<typeof repositoryStateSchema>;

export const repositoryTerminalStateSchema = z.enum(
  REPOSITORY_TERMINAL_STATES,
);
export type RepositoryTerminalState = z.infer<
  typeof repositoryTerminalStateSchema
>;

export function isTerminalRepositoryState(
  state: RepositoryState,
): state is RepositoryTerminalState {
  return (REPOSITORY_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Scan-request (account-level) state vocabulary (ADR-004, confirmed in
 * review pass 2). The authority documents fix the repository state machine
 * but do not enumerate account-level request states; this is deliberately the
 * smallest closed set that fits the accepted API surface.
 *
 * Semantics:
 * - `accepted`: durable request created, discovery not started.
 * - `discovering`: enumerating owned public repositories.
 * - `scanning`: ledger exists; at least one repository is non-terminal.
 * - `complete`: every ledger repository reached a terminal state. This is
 *   the ONLY success terminal — per-repository `partial`/`failed`/`cancelled`
 *   detail lives in `repositoryTotals`, so there is no request-level
 *   `partial` or `cancelled` state to keep in sync.
 * - `failed`: the request itself could not proceed (e.g. discovery failed,
 *   scope rejection), not an aggregate of repository failures.
 */
export const SCAN_REQUEST_STATES = [
  "accepted",
  "discovering",
  "scanning",
  "complete",
  "failed",
] as const;

export const scanRequestStateSchema = z.enum(SCAN_REQUEST_STATES);
export type ScanRequestState = z.infer<typeof scanRequestStateSchema>;
