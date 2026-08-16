import { z } from "zod";
import {
  brokerDerivedFindingSchema,
  commitShaSchema,
  failureClassSchema,
  githubLoginSchema,
  githubRepoNameSchema,
  nonNegativeIntSchema,
  opaqueIdSchema,
  repositoryCoverageSchema,
  repositoryStateSchema,
  scanRequestStateSchema,
  specialistCoverageOutcomeSchema,
  specialistSchema,
  specialistReasonsSchema,
} from "@app/contracts";

const positiveIntSchema = z.number().int().positive();

export const scanRequestRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: opaqueIdSchema,
  githubAccountId: nonNegativeIntSchema.nullable(),
  username: githubLoginSchema,
  state: scanRequestStateSchema,
  reason: failureClassSchema.nullable(),
  discoveryComplete: z.boolean(),
  aiLane: z.enum(["ai_not_run", "ai_waiting", "ai_partial"]),
  createdAtMs: nonNegativeIntSchema,
  updatedAtMs: nonNegativeIntSchema,
});

export const repositoryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: opaqueIdSchema,
  repositoryId: nonNegativeIntSchema,
  name: githubRepoNameSchema,
  isFork: z.boolean(),
  commitSha: commitShaSchema.nullable(),
  state: repositoryStateSchema,
  reason: failureClassSchema.nullable(),
  coverage: repositoryCoverageSchema,
  specialistReasons: specialistReasonsSchema,
  attemptCount: nonNegativeIntSchema,
  leaseGeneration: nonNegativeIntSchema,
  lease: z
    .strictObject({
      workerId: opaqueIdSchema,
      generation: positiveIntSchema,
      expiresAtMs: nonNegativeIntSchema,
    })
    .nullable(),
  publishedLeaseGeneration: positiveIntSchema.nullable(),
  discoveredAtMs: nonNegativeIntSchema,
  updatedAtMs: nonNegativeIntSchema,
});

export const leaseReferenceSchema = z.strictObject({
  requestId: opaqueIdSchema,
  repositoryId: nonNegativeIntSchema,
  generation: positiveIntSchema,
});

export const claimBodySchema = z.strictObject({
  leaseDurationMs: positiveIntSchema.max(20 * 60 * 1_000),
});

export const heartbeatBodySchema = leaseReferenceSchema.extend({
  leaseDurationMs: positiveIntSchema.max(20 * 60 * 1_000),
});

export const transitionBodySchema = leaseReferenceSchema.extend({
  expectedState: z.enum([
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
  ]),
  nextState: z.enum([
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
  ]),
});

const publicationCoverageSchema = z.record(
  specialistSchema,
  specialistCoverageOutcomeSchema,
);

export const publishBodySchema = leaseReferenceSchema.extend({
  terminalState: z.enum(["complete", "partial", "failed", "cancelled"]),
  reason: failureClassSchema.nullable(),
  coverage: publicationCoverageSchema,
  specialistReasons: specialistReasonsSchema,
  findings: z.array(brokerDerivedFindingSchema).max(1_024),
});

export const classifyExpiredResponseSchema = z.strictObject({
  retryable: z.array(leaseReferenceSchema).max(100),
  exhausted: z.array(leaseReferenceSchema).max(100),
});

export const publicationResultSchema = z.enum([
  "published",
  "idempotent",
  "stale_lease",
  "idempotency_conflict",
  "invalid_state",
]);

export const booleanResultSchema = z.strictObject({ result: z.boolean() });
export const claimResponseSchema = z.strictObject({
  repository: repositoryRecordSchema.nullable(),
});
export const requestResponseSchema = z.strictObject({
  request: scanRequestRecordSchema.nullable(),
});
export const publicationResponseSchema = z.strictObject({
  result: publicationResultSchema,
});
export const protocolErrorSchema = z.strictObject({
  reason: z.enum([
    "AUTH_REQUIRED",
    "AUTH_INVALID",
    "INVALID_BODY",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
  ]),
});

export const WORKER_PROTOCOL_PATHS = {
  claim: "/internal/v1/claim",
  heartbeat: "/internal/v1/heartbeat",
  classifyExpired: "/internal/v1/leases/classify-expired",
  requeueCleaned: "/internal/v1/leases/requeue-cleaned",
  finalizeExhausted: "/internal/v1/leases/finalize-exhausted",
  retryCleaned: "/internal/v1/leases/retry-cleaned",
  transition: "/internal/v1/transition",
  publish: "/internal/v1/publish",
} as const;

export type WorkerProtocolPath =
  (typeof WORKER_PROTOCOL_PATHS)[keyof typeof WORKER_PROTOCOL_PATHS];
