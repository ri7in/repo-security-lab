import { z } from "zod";
import { brokerResultPacketSchema } from "./broker.js";
import { scanEngineSchema } from "./coverage.js";
import { failureClassSchema } from "./failure.js";

const normalizedEngineResultSchema = z.strictObject({
  engine: scanEngineSchema,
  coverage: z.enum(["complete", "partial"]),
  reason: z.literal("FINDING_LIMIT").nullable(),
  packet: brokerResultPacketSchema,
});

/**
 * The only file allowed to leave the credential-free scan namespace.
 * It has no free-form or archive-derived string field.
 */
export const scanDomainResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  applicability: z.strictObject({
    osv: z.boolean(),
    zizmor: z.boolean(),
    opengrep: z.boolean(),
  }),
  engineResults: z.array(normalizedEngineResultSchema).max(4),
  engineFailures: z.partialRecord(scanEngineSchema, failureClassSchema),
});
export type ScanDomainResult = z.infer<typeof scanDomainResultSchema>;

export const guardDomainResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["ARCHIVE_LIMIT", "ARCHIVE_UNSAFE", "ARCHIVE_INVALID"]),
  }),
]);
export type GuardDomainResult = z.infer<typeof guardDomainResultSchema>;

/** Fixed startup proof emitted from inside the Linux scan namespace. */
export const scanDomainProbeResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  networkDenied: z.literal(true),
  credentialPathsHidden: z.literal(true),
  outsideWriteDenied: z.literal(true),
  environmentClean: z.literal(true),
});
export type ScanDomainProbeResult = z.infer<typeof scanDomainProbeResultSchema>;
