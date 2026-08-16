import { z } from "zod";

/**
 * Fixed failure classes from the accepted orchestration contract, plus
 * `PRIVATE_SLICE_SCOPE` (added by the 2026-08-16 implementation plan): the
 * control plane structurally refuses usernames outside the private-slice
 * allowlist until enforced Linux isolation passes.
 *
 * Human-readable text always comes from versioned templates keyed by these
 * classes. Scanner stderr and target-controlled strings never become error
 * messages, API responses, or model input.
 */
export const FAILURE_CLASSES = [
  "GITHUB_RATE_LIMIT",
  "GITHUB_NOT_FOUND",
  "GITHUB_NETWORK",
  "GITHUB_AUTH",
  "ARCHIVE_LIMIT",
  "ARCHIVE_UNSAFE",
  "ARCHIVE_INVALID",
  "REPOSITORY_CHANGED",
  "VULNERABILITY_DB_UNVERIFIED",
  "VULNERABILITY_DB_STALE",
  "VULNERABILITY_DB_MISMATCH",
  "SCANNER_TIMEOUT",
  "SCANNER_MEMORY_LIMIT",
  "SCANNER_OUTPUT_LIMIT",
  "SCANNER_INTERNAL",
  "UNSUPPORTED_ECOSYSTEM",
  "NORMALIZATION_REJECTED",
  "FINDING_LIMIT",
  "SOURCE_CLEANUP_FAILED",
  "LEASE_RETRY_EXHAUSTED",
  "D1_WRITE_RESERVE",
  "CANCELLED",
  "PRIVATE_SLICE_SCOPE",
] as const;

export const failureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof failureClassSchema>;
