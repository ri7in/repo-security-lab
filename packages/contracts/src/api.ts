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
  scanEngineSchema,
  specialistProgressStateSchema,
  specialistSchema,
} from "./coverage.js";
import { failureClassSchema } from "./failure.js";
import { brokerDerivedFindingSchema } from "./broker.js";

/**
 * Public-safe API DTOs. Status and coverage cannot express finding data or
 * archive/scanner strings. The separate public finding DTO is a strict subset
 * of source-blind broker output and cannot express paths, snippets, matches,
 * secret characters, or internal owner-detail references.
 */

/** `POST /api/scan-requests` request body. */
export const createScanRequestBodySchema = z.strictObject({
  username: githubLoginSchema,
  /** Optional one-shot report notification; never returned by the API. */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254))
    .optional(),
});
export type CreateScanRequestBody = z.infer<typeof createScanRequestBodySchema>;

/** `202 Accepted` response body. */
export const scanRequestAcceptedSchema = z.strictObject({
  requestId: opaqueIdSchema,
  notification: z.enum(["not_requested", "queued", "unavailable", "rate_limited"]),
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
  "RATE_LIMITED",
  "CAPACITY_EXHAUSTED",
  "EMAIL_UNAVAILABLE",
]);
export type ApiRejectionReason = z.infer<typeof apiRejectionReasonSchema>;

export const apiErrorSchema = z.strictObject({
  reason: apiRejectionReasonSchema,
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Public, source-free product capabilities used to keep UI promises honest. */
export const publicCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scanCreation: z.enum(["private_preview", "public"]),
  emailNotifications: z.boolean(),
  scanEtaMinutes: z.strictObject({
    min: z.number().int().positive().max(60),
    max: z.number().int().positive().max(60),
  }),
});
export type PublicCapabilities = z.infer<typeof publicCapabilitiesSchema>;

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
  /** Fixed request-level failure only; never upstream or target prose. */
  reason: failureClassSchema.optional(),
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

/** Optional fixed reasons for scan engines that ended in `failed`. */
export const specialistReasonsSchema = z.partialRecord(
  scanEngineSchema,
  failureClassSchema,
);
export type SpecialistReasons = z.infer<typeof specialistReasonsSchema>;

/** One row of `GET /api/scan-requests/:id/repositories`. No finding data. */
export const repositoryRowSchema = z.strictObject({
  repositoryId: nonNegativeIntSchema,
  /** From GitHub discovery (control plane), never scanner/archive output. */
  name: githubRepoNameSchema,
  state: repositoryStateSchema,
  /** Present only when a fixed failure class explains the current state. */
  reason: failureClassSchema.optional(),
  coverage: repositoryCoverageSchema,
  specialistReasons: specialistReasonsSchema.optional(),
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

export const publicFindingSchema = brokerDerivedFindingSchema.pick({
  schema_version: true,
  repository_id: true,
  commit_sha: true,
  engine: true,
  rule_id: true,
  category: true,
  severity: true,
  confidence: true,
  occurrence_bucket: true,
  remediation_key: true,
});
export type PublicFinding = z.infer<typeof publicFindingSchema>;

/** Public source-blind finding page. */
export const publicFindingPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  findings: z.array(publicFindingSchema).max(100),
  nextCursor: opaqueIdSchema.optional(),
});
export type PublicFindingPage = z.infer<typeof publicFindingPageSchema>;

/**
 * Loopback operator page retains full broker identity fields for local proofs.
 */
export const operatorFindingPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  findings: z.array(brokerDerivedFindingSchema).max(100),
  nextCursor: opaqueIdSchema.optional(),
});
export type OperatorFindingPage = z.infer<typeof operatorFindingPageSchema>;
