import { z } from "zod";
import {
  githubLoginSchema,
  githubRepoNameSchema,
  nonNegativeIntSchema,
  opaqueIdSchema,
} from "./primitives.js";
import {
  repositoryStateSchema,
  scanRequestStateSchema,
} from "./states.js";
import {
  aiLaneStateSchema,
  specialistProgressStateSchema,
  specialistSchema,
} from "./coverage.js";
import { failureClassSchema } from "./failure.js";

/**
 * Anonymous-safe API DTOs (D-043): status and coverage only. These schemas
 * cannot express finding data, secret-derived counts, paths, snippets, or any
 * archive/scanner string. Repository names come exclusively from the control
 * plane's GitHub discovery record. Owner-gated finding DTOs are deferred to
 * the operator/OAuth stages.
 */

/** `POST /api/scan-requests` request body. */
export const createScanRequestBodySchema = z.strictObject({
  username: githubLoginSchema,
});
export type CreateScanRequestBody = z.infer<typeof createScanRequestBodySchema>;

/** `202 Accepted` response body. */
export const scanRequestAcceptedSchema = z.strictObject({
  requestId: opaqueIdSchema,
});
export type ScanRequestAccepted = z.infer<typeof scanRequestAcceptedSchema>;

/**
 * Fixed, non-echoing API rejection reasons. `PRIVATE_SLICE_SCOPE` maps to
 * HTTP 403 and `DUPLICATE_ACTIVE_REQUEST` to HTTP 409 per the implementation
 * plan. Rejected input is never echoed back.
 */
export const apiRejectionReasonSchema = z.enum([
  "INVALID_USERNAME",
  "PRIVATE_SLICE_SCOPE",
  "DUPLICATE_ACTIVE_REQUEST",
]);
export type ApiRejectionReason = z.infer<typeof apiRejectionReasonSchema>;

export const apiErrorSchema = z.strictObject({
  reason: apiRejectionReasonSchema,
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Exhaustive per-state repository totals (zero-filled, no omitted states). */
export const repositoryStateTotalsSchema = z.record(
  repositoryStateSchema,
  nonNegativeIntSchema,
);
export type RepositoryStateTotals = z.infer<typeof repositoryStateTotalsSchema>;

/**
 * Exhaustive per-specialist, per-progress-state totals. The API is explicitly
 * progressive: `waiting` counts repositories the specialist has not reached,
 * never a coverage outcome.
 */
export const coverageTotalsSchema = z.record(
  specialistSchema,
  z.record(specialistProgressStateSchema, nonNegativeIntSchema),
);
export type CoverageTotals = z.infer<typeof coverageTotalsSchema>;

/** `GET /api/scan-requests/:id` account summary. */
export const scanRequestSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: opaqueIdSchema,
  username: githubLoginSchema,
  state: scanRequestStateSchema,
  repositoryTotals: repositoryStateTotalsSchema,
  coverageTotals: coverageTotalsSchema,
  aiLane: aiLaneStateSchema,
  /** Client polling backoff hint. */
  retryAfterSeconds: z.number().int().positive().max(3600),
  updatedAt: z.iso.datetime(),
});
export type ScanRequestSummary = z.infer<typeof scanRequestSummarySchema>;

/**
 * Exhaustive per-repository specialist progress map. `waiting` means the
 * specialist has not run for this repository; only the five outcome values
 * mean anything was actually scanned.
 */
export const repositoryCoverageSchema = z.record(
  specialistSchema,
  specialistProgressStateSchema,
);
export type RepositoryCoverage = z.infer<typeof repositoryCoverageSchema>;

/** One row of `GET /api/scan-requests/:id/repositories`. No finding data. */
export const repositoryRowSchema = z.strictObject({
  repositoryId: nonNegativeIntSchema,
  /** From GitHub discovery (control plane), never scanner/archive output. */
  name: githubRepoNameSchema,
  state: repositoryStateSchema,
  /** Present only when a fixed failure class explains the current state. */
  reason: failureClassSchema.optional(),
  coverage: repositoryCoverageSchema,
  aiLane: aiLaneStateSchema,
});
export type RepositoryRow = z.infer<typeof repositoryRowSchema>;

export const MAX_REPOSITORY_PAGE_SIZE = 100;

/** Paginated repository ledger page. */
export const repositoryPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: opaqueIdSchema,
  repositories: z.array(repositoryRowSchema).max(MAX_REPOSITORY_PAGE_SIZE),
  nextCursor: opaqueIdSchema.optional(),
});
export type RepositoryPage = z.infer<typeof repositoryPageSchema>;
