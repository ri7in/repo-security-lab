import { z } from "zod";

/**
 * Deterministic scan engines whose results may cross the source-blind broker.
 * In the first slice only Gitleaks runs; OSV, zizmor, and Opengrep land as
 * fail-closed stubs that report `unsupported`/`failed` coverage and never
 * fabricate results.
 */
export const SCAN_ENGINES = ["gitleaks", "osv", "zizmor", "opengrep"] as const;
export const scanEngineSchema = z.enum(SCAN_ENGINES);
export type ScanEngine = z.infer<typeof scanEngineSchema>;

/**
 * Specialists that report per-repository coverage in the ledger. Snapshot
 * acquisition and the archive guard are coverage-bearing stages in addition
 * to the four scan engines.
 */
export const SPECIALISTS = [
  "snapshot",
  "archive_guard",
  ...SCAN_ENGINES,
] as const;
export const specialistSchema = z.enum(SPECIALISTS);
export type Specialist = z.infer<typeof specialistSchema>;

/**
 * Coverage outcomes from the accepted orchestration contract: each specialist
 * reports EXACTLY one of these five terminal outcomes for a scanned
 * repository. This is the only vocabulary that may ever be presented or
 * persisted as a coverage result.
 */
export const SPECIALIST_COVERAGE_OUTCOMES = [
  "complete",
  "not_applicable",
  "unsupported",
  "partial",
  "failed",
] as const;

export const specialistCoverageOutcomeSchema = z.enum(
  SPECIALIST_COVERAGE_OUTCOMES,
);
export type SpecialistCoverageOutcome = z.infer<
  typeof specialistCoverageOutcomeSchema
>;

/**
 * Progressive durable/API state. `waiting` means "this specialist has not run
 * yet"; it is NOT a coverage outcome and may never be presented or counted as
 * a completed scan result.
 */
export const SPECIALIST_PROGRESS_STATES = [
  "waiting",
  ...SPECIALIST_COVERAGE_OUTCOMES,
] as const;

export const specialistProgressStateSchema = z.enum(
  SPECIALIST_PROGRESS_STATES,
);
export type SpecialistProgressState = z.infer<
  typeof specialistProgressStateSchema
>;

/**
 * AI review lane states. The private slice always reports `ai_not_run` in
 * production mode: no model client exists in the dependency graph, and
 * deterministic coverage is never mislabeled as AI review. Additional lane
 * states arrive only with the real, separately gated AI implementation.
 */
export const AI_LANE_STATES = [
  "ai_not_run",
  "ai_waiting",
  "ai_partial",
  "ai_complete",
] as const;
export const aiLaneStateSchema = z.enum(AI_LANE_STATES);
export type AiLaneState = z.infer<typeof aiLaneStateSchema>;
