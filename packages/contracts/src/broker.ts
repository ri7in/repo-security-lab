import { z } from "zod";
import { commitShaSchema, boundedTokenSchema, opaqueIdSchema } from "./primitives.js";
import { scanEngineSchema } from "./coverage.js";

/**
 * Source-blind broker primitives (D-052).
 *
 * The hostile normalization domain may emit ONLY manifest-issued numeric
 * tokens and four count-bucket codes. No path, package name, source location,
 * finding id, prose, rule/advisory string, or any other archive/scanner
 * string may cross THIS boundary. Published source locations do exist now, but
 * they travel in their own bounded channel and are attached by the broker
 * outside the hostile domain; nothing below is relaxed to admit them. Engine identity is NOT packet content: it
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

/** Hard ceiling of published locations per finding. */
export const MAX_LOCATIONS_PER_FINDING = 20;

/**
 * A published source location: where a finding sits, never what it contains.
 *
 * This is the field that ended source-blind reporting, and the reasoning
 * belongs here rather than in a commit message. A report saying only "a secret
 * rule matched a few times" is not actionable: an owner cannot fix what they
 * cannot find. The location is the entire difference between a curiosity and a
 * usable security report.
 *
 * It is deliberately only a path and a line. There is no snippet, no match,
 * and no secret value, and there is no room for one: gitleaks runs under
 * `--redact`, so the value never exists on this side of the scanner at all.
 *
 * Locations do NOT travel in the broker packet. They arrive through the
 * separately bounded location channel and are attached outside the hostile
 * domain, so the packet keeps its numbers-only property and the egress proof
 * guarding it stays exactly as strong as it was.
 */
export const sourceLocationSchema = z.strictObject({
  path: z.string().min(1).max(256),
  startLine: z.number().int().positive(),
});
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

/**
 * Persisted hosted finding (schema_version 1) exactly as accepted in the
 * orchestration contract. Every field is broker-derived from trusted
 * manifests and control-plane lease identity. The schema is deliberately
 * closed: it cannot express a match, snippet, source line, path, filename,
 * package name, raw scanner message, prose, or secret. Field names keep the
 * accepted snake_case wire format.
 *
 * `locations` is the single deliberate exception to "no archive-derived
 * string": see `sourceLocationSchema`. It is optional so that findings stored
 * before this field existed still parse.
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
  locations: z
    .array(sourceLocationSchema)
    .max(MAX_LOCATIONS_PER_FINDING)
    .optional(),
});
export type BrokerDerivedFinding = z.infer<typeof brokerDerivedFindingSchema>;
