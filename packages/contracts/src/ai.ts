import { z } from "zod";
import { boundedTokenSchema } from "./primitives.js";

/**
 * AI lane contracts for the private slice (D-066): typed interfaces and
 * deterministic fixture tagging only. No network provider adapter exists, no
 * model client is in the dependency graph, and no repository byte can reach a
 * model. Real provider kinds may be added to these closed vocabularies only
 * together with the recorded provider-proof checklist (ZDR confirmation,
 * consent flow, sanitizer corpus pass, benchmark id) required by the
 * implementation plan.
 */

/** The deterministic-double provider tag. */
export const FIXTURE_PROVIDER = "fixture" as const;

/**
 * Closed provider-tag vocabulary. `fixture` stays first and remains the only
 * tag a deterministic double may carry, so replayed output can never be
 * mistaken for real model review. Live tags name the routing surface rather
 * than the model, because a single surface may serve several model families.
 */
export const AI_PROVIDER_TAGS = [
  FIXTURE_PROVIDER,
  "openrouter",
  "groq",
  "gemini",
] as const;
export const aiProviderTagSchema = z.enum(AI_PROVIDER_TAGS);
export type AiProviderTag = z.infer<typeof aiProviderTagSchema>;

/** AI activation modes. Production default stays `disabled`. */
export const AI_MODES = ["disabled", "fixture", "live"] as const;
export const aiModeSchema = z.enum(AI_MODES);
export type AiMode = z.infer<typeof aiModeSchema>;
export const DEFAULT_AI_MODE: AiMode = "disabled";

/**
 * Report tiers from the accepted AI-detection architecture. `deterministic`
 * findings are immutable and never suppressed by AI; `rejected` exists only
 * as aggregate model-quality telemetry and is never displayed as a
 * vulnerability.
 */
export const REVIEW_TIERS = [
  "deterministic",
  "ai_confirmed",
  "ai_probable",
  "needs_human_review",
  "rejected",
] as const;
export const reviewTierSchema = z.enum(REVIEW_TIERS);
export type ReviewTier = z.infer<typeof reviewTierSchema>;

/**
 * Static policy describing a (future) provider role. Typed only; carrying a
 * policy object grants no network capability. `zdrRequired` must be true for
 * any provider that would ever receive sanitized owner-authorized data.
 */
export const providerPolicySchema = z.strictObject({
  family: boundedTokenSchema,
  zdrRequired: z.boolean(),
  termsVersion: boundedTokenSchema,
});
export type ProviderPolicy = z.infer<typeof providerPolicySchema>;

/**
 * Tag carried by every deterministic AI fixture artifact (scout/judge replay
 * files). The `provider` literal makes fixture output structurally
 * unconfusable with real review.
 */
export const aiFixtureArtifactTagSchema = z.strictObject({
  // Deliberately the literal, not `aiProviderTagSchema`. Opening the provider
  // vocabulary for the live lane must never let a replayed fixture tag itself
  // as real model review.
  provider: z.literal(FIXTURE_PROVIDER),
  fixtureId: boundedTokenSchema,
});
export type AiFixtureArtifactTag = z.infer<typeof aiFixtureArtifactTagSchema>;

export const AI_CWE_IDS = [
  "CWE-22",
  "CWE-78",
  "CWE-79",
  "CWE-89",
  "CWE-94",
  "CWE-287",
  "CWE-352",
  "CWE-502",
  "CWE-918",
  "CWE-1321",
] as const;
export const aiCweSchema = z.enum(AI_CWE_IDS);

export const AI_PRECONDITIONS = [
  "remote-input",
  "authenticated-input",
  "local-input",
  "attacker-controlled-file",
  "unsafe-configuration",
] as const;
export const aiPreconditionSchema = z.enum(AI_PRECONDITIONS);

export const AI_IMPACTS = [
  "code-execution",
  "data-disclosure",
  "data-modification",
  "authorization-bypass",
  "service-disruption",
] as const;
export const aiImpactSchema = z.enum(AI_IMPACTS);

export const AI_MISSING_EVIDENCE = [
  "source",
  "sink",
  "trace",
  "precondition",
  "sanitizer",
] as const;
export const aiMissingEvidenceSchema = z.enum(AI_MISSING_EVIDENCE);

/** Strict transient scout output. It is grounded then discarded, never hosted. */
export const aiCandidateSchema = z.strictObject({
  provider: aiProviderTagSchema,
  fixtureId: boundedTokenSchema,
  candidateId: boundedTokenSchema,
  cwe: aiCweSchema,
  fileToken: z.number().int().nonnegative(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  evidenceQuote: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  sourceSymbol: z.number().int().nonnegative(),
  sinkSymbol: z.number().int().nonnegative(),
  traceEdges: z.array(z.number().int().nonnegative()).max(64),
  attackPreconditions: z.array(aiPreconditionSchema).max(5),
  impact: aiImpactSchema,
  confidence: z.enum(["high", "medium", "low"]),
  missingEvidence: z.array(aiMissingEvidenceSchema).max(5),
});
export type AiCandidate = z.infer<typeof aiCandidateSchema>;


/**
 * Pass-1 scout flag: a triage pointer, not a finding.
 *
 * The scout reads a whole account in one request and returns places worth a
 * closer look. Flags are deliberately cheaper to express than
 * `aiCandidateSchema`: no symbol graph, because no code map is built for the
 * triage pass. A flag is never published on its own. It must survive the
 * grounding gate and then a council vote before it can reach a report.
 */
export const aiScoutFlagSchema = z.strictObject({
  /** Stable within one pack; the model echoes the token we assigned. */
  fileToken: z.number().int().nonnegative(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  /**
   * Text the model claims sits at those lines. The grounding gate requires
   * this to appear verbatim in the pack, which is what makes a fabricated
   * flag structurally detectable rather than merely unlikely.
   */
  evidenceQuote: z
    .string()
    .min(8)
    .max(500)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)),
  cwe: aiCweSchema,
  impact: aiImpactSchema,
  /** Why this is worth judging. Bounded so a flag cannot carry prose payloads. */
  rationale: z.string().min(1).max(400),
  confidence: z.enum(["high", "medium", "low"]),
});
export type AiScoutFlag = z.infer<typeof aiScoutFlagSchema>;

/** The scout's whole response. A single malformed flag rejects the document. */
export const aiScoutResponseSchema = z.strictObject({
  flags: z.array(aiScoutFlagSchema).max(200),
});
export type AiScoutResponse = z.infer<typeof aiScoutResponseSchema>;

/**
 * One judge's independent vote on one grounded flag.
 *
 * Judges never see each other's votes. `unsure` is a first-class outcome so a
 * judge is not pushed into a false binary, and it counts against publication.
 */
export const aiJudgeVerdictSchema = z.strictObject({
  verdict: z.enum(["real", "not_real", "unsure"]),
  reason: z.string().min(1).max(400),
});
export type AiJudgeVerdict = z.infer<typeof aiJudgeVerdictSchema>;
