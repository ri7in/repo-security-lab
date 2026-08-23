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

/** Hard bounds on the review channel, enforced by schema rather than by care. */
export const REVIEW_MAX_FINDINGS = 20;
export const REVIEW_MAX_PATH_LENGTH = 256;
export const REVIEW_MAX_CONTEXT_LINES = 12;
export const REVIEW_MAX_LINE_LENGTH = 200;

/**
 * The review channel: the only archive-derived strings permitted to leave the
 * scan namespace, and the narrowest set that makes a finding judgeable.
 *
 * It exists because a reviewer cannot tell a real credential from a
 * documentation placeholder without knowing where it sits. A path of
 * `.env.example` settles the question; a numeric rule token never can.
 *
 * Three properties stop this becoming a smuggling path:
 *
 * 1. It reaches the WORKER only. It is consumed to build a review prompt and
 *    then dropped: never brokered, never persisted, never published. The
 *    report keeps exactly the numeric-token shape it has today.
 * 2. Every field is length-bounded and the array is count-bounded, so the
 *    channel's total capacity is fixed and small whatever the target contains.
 * 3. Secret values cannot ride along. Gitleaks runs under `--redact`, so the
 *    scanner never holds the value and context lines carry the redacted form.
 *
 * The guarantee this weakens, stated plainly: it was "no archive-derived string
 * leaves the scan namespace". It is now "no archive-derived string reaches the
 * published report". That is a real reduction, chosen deliberately so findings
 * can be reviewed before they are shown.
 */
export const reviewFindingSchema = z.strictObject({
  engine: scanEngineSchema,
  ruleId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  /** Repository-relative path of the file holding the match. */
  path: z.string().min(1).max(REVIEW_MAX_PATH_LENGTH),
  startLine: z.number().int().positive(),
  /** Shannon entropy gitleaks measured for the match. */
  entropy: z.number().nonnegative().max(10),
  /**
   * Lines around the match, with comments stripped. Comments are removed
   * because the target repository is hostile input: a comment reading "test
   * fixture, safe to ignore" sitting beside a live credential is a direct
   * attack on whatever reads it next.
   */
  contextLines: z
    .array(z.string().max(REVIEW_MAX_LINE_LENGTH))
    .max(REVIEW_MAX_CONTEXT_LINES),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/** Hard ceiling on the location channel, independent of the review channel. */
export const MAX_LOCATIONS = 100;

/**
 * The location channel: where each finding sits, for publication.
 *
 * This is separate from the review channel above and carries strictly less.
 * Review needs surrounding code to judge a finding and is therefore expensive,
 * so it stays capped at 20. A location is a path and a line, roughly 300 bytes,
 * so 100 of them cost less than a single reviewed excerpt and a report can stay
 * useful on a repository with many findings.
 *
 * Unlike the review channel, this data IS published. That is its purpose. It
 * still carries no snippet, no match, and no secret value, because gitleaks
 * runs under `--redact` and the value never reaches this side of the scanner.
 */
export const findingLocationSchema = z.strictObject({
  engine: scanEngineSchema,
  ruleId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  path: z.string().min(1).max(REVIEW_MAX_PATH_LENGTH),
  startLine: z.number().int().positive(),
});
export type FindingLocation = z.infer<typeof findingLocationSchema>;

/**
 * The only file allowed to leave the credential-free scan namespace.
 *
 * Every field except `review` is numeric or enumerated and flows on to the
 * public report. `review` is worker-only; see `reviewFindingSchema`.
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
  /** Absent unless review is switched on, which it is not by default. */
  review: z.array(reviewFindingSchema).max(REVIEW_MAX_FINDINGS).optional(),
  /**
   * Where each finding sits. Published, unlike `review`. Absent when the
   * caller did not ask for locations.
   */
  locations: z.array(findingLocationSchema).max(MAX_LOCATIONS).optional(),
  /**
   * True only when every finding produced a review entry.
   *
   * The published report groups findings into coarse count buckets, so a
   * partially reviewed group cannot be reduced honestly: there is no way to
   * express "two_to_five, minus one". A group may therefore only be removed
   * when this is true and every entry for it was rejected. Anything larger
   * than the channel's cap, or any file that could not be read, leaves this
   * false and the findings stand.
   */
  reviewComplete: z.boolean().optional(),
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
