import { z } from "zod";
import { commitShaSchema, boundedTokenSchema, opaqueIdSchema } from "./primitives.js";
import { scanEngineSchema } from "./coverage.js";

/**
 * Source-blind broker primitives (D-052).
 *
 * The hostile normalization domain may emit ONLY manifest-issued numeric
 * tokens and four count-bucket codes. No path, package name, source location,
 * finding id, prose, rule/advisory string, or any other archive/scanner
 * string may cross this boundary. Engine identity is NOT packet content: it
 * is fixed out-of-band by the broker-owned per-engine channel and the lease
 * (one fixed engine channel per the threat model), so the hostile domain
 * cannot relabel a packet and route tokens through another engine's manifest.
 * The broker maps tokens through the pinned trusted manifest for the channel
 * engine, derives all metadata, injects lease identity, and rejects the whole
 * result on any violation with a fixed non-echoing reason.
 */

/** Fixed occurrence-count buckets; integer codes 0..3 on the wire. */
export const COUNT_BUCKET_LABELS = [
  "one",
  "two_to_five",
  "six_to_twenty",
  "twenty_one_plus",
] as const;

export const occurrenceBucketSchema = z.enum(COUNT_BUCKET_LABELS);
export type OccurrenceBucket = z.infer<typeof occurrenceBucketSchema>;

export const countBucketCodeSchema = z.number().int().min(0).max(3);
export type CountBucketCode = z.infer<typeof countBucketCodeSchema>;

export function occurrenceBucketFromCode(code: CountBucketCode): OccurrenceBucket {
  const label = COUNT_BUCKET_LABELS[code];
  if (label === undefined) {
    throw new RangeError("count bucket code out of range");
  }
  return label;
}

/** Numeric token issued by the pinned engine/database manifest. */
export const manifestTokenSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export type ManifestToken = z.infer<typeof manifestTokenSchema>;

/** Hard ceiling of unique groups per engine and repository (D-052). */
export const MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY = 256;

/** One token/count-bucket group proposed by the hostile normalizer. */
export const brokerGroupSchema = z.strictObject({
  token: manifestTokenSchema,
  bucket: countBucketCodeSchema,
});
export type BrokerGroup = z.infer<typeof brokerGroupSchema>;

/**
 * Complete per-engine result packet crossing the hostile-domain egress
 * boundary. It deliberately carries NO engine field: the receiving broker
 * already knows the engine from the channel/lease. Strict shape: unknown
 * keys (including a well-formed `engine` string), non-numeric values,
 * duplicate tokens, or an over-limit group count reject the whole packet.
 */
export const brokerResultPacketSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    groups: z
      .array(brokerGroupSchema)
      .max(MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY),
  })
  .superRefine((packet, context) => {
    const seen = new Set<number>();
    for (const group of packet.groups) {
      if (seen.has(group.token)) {
        context.addIssue({
          code: "custom",
          message: "duplicate manifest token",
          path: ["groups"],
        });
        return;
      }
      seen.add(group.token);
    }
  });
export type BrokerResultPacket = z.infer<typeof brokerResultPacketSchema>;

/** Broker-derived severity/confidence vocabularies (closed). */
export const severitySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
  "unknown",
]);
export type Severity = z.infer<typeof severitySchema>;

export const confidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
export type Confidence = z.infer<typeof confidenceSchema>;

/**
 * Persisted hosted finding (schema_version 1) exactly as accepted in the
 * orchestration contract. Every field is broker-derived from trusted
 * manifests and control-plane lease identity. The schema is deliberately
 * closed: it cannot express a match, snippet, source line, path, filename,
 * package name, raw scanner message, prose, or secret. Field names keep the
 * accepted snake_case wire format.
 */
export const brokerDerivedFindingSchema = z.strictObject({
  schema_version: z.literal(1),
  finding_id: opaqueIdSchema,
  request_id: opaqueIdSchema,
  repository_id: z.number().int().nonnegative(),
  commit_sha: commitShaSchema,
  engine: scanEngineSchema,
  rule_id: boundedTokenSchema,
  category: boundedTokenSchema,
  severity: severitySchema,
  confidence: confidenceSchema,
  occurrence_bucket: occurrenceBucketSchema,
  remediation_key: boundedTokenSchema,
  owner_detail_ref: opaqueIdSchema,
});
export type BrokerDerivedFinding = z.infer<typeof brokerDerivedFindingSchema>;
