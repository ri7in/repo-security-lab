/**
 * Free-tier model allowances for the deep-read lane.
 *
 * Every number here is a provider fact with a source and a verification date.
 * Providers change free limits without notice, so `verifiedOn` is part of the
 * record and `docs/maintenance.md` requires a recheck before each release.
 * Nothing in this file may be estimated: an unverifiable limit is omitted and
 * its model cannot be registered.
 */

export type ModelRole = "reader" | "judge";

export interface ModelAllowance {
  /** Provider-qualified model id exactly as the provider spells it. */
  readonly id: string;
  readonly provider: "groq" | "gemini" | "openrouter";
  /** `reader` ingests whole repositories; `judge` re-checks single findings. */
  readonly role: ModelRole;
  /** Tokens per day, or null when the provider publishes no daily token cap. */
  readonly tokensPerDay: number | null;
  /**
   * Tokens per minute, or null where the provider publishes none. This, not
   * the context window, bounds the largest single prompt we can send.
   */
  readonly tokensPerMinute: number | null;
  /** Model context window. */
  readonly contextWindow: number;
  /** Requests per day. */
  readonly requestsPerDay: number;
  readonly sourceUrl: string;
  /** ISO date on which a human read `sourceUrl` and confirmed these numbers. */
  readonly verifiedOn: string;
}

/**
 * Groq free tier, read from the provider's own rate-limit table.
 *
 * The binding constraint is `tokensPerMinute`, not `tokensPerDay`. At 8,000
 * tokens per minute a Groq free request cannot carry a whole repository, so
 * these models are judges over single findings and can never be readers.
 */
export const GROQ_QWEN: ModelAllowance = {
  id: "qwen/qwen3.6-27b",
  provider: "groq",
  role: "judge",
  tokensPerDay: 200_000,
  tokensPerMinute: 8_000,
  contextWindow: 131_072,
  requestsPerDay: 1_000,
  sourceUrl: "https://console.groq.com/docs/rate-limits",
  verifiedOn: "2026-08-21",
};

export const GROQ_GPT_OSS: ModelAllowance = {
  id: "openai/gpt-oss-120b",
  provider: "groq",
  role: "judge",
  tokensPerDay: 200_000,
  tokensPerMinute: 8_000,
  contextWindow: 131_072,
  requestsPerDay: 1_000,
  sourceUrl: "https://console.groq.com/docs/rate-limits",
  verifiedOn: "2026-08-21",
};

/**
 * Gemini free tier.
 *
 * Google's public rate-limit page defers to each project's AI Studio dashboard
 * rather than publishing a table, so these numbers are UNCONFIRMED against a
 * primary source and are marked as such. `tokensPerDay` is null because no
 * daily token cap is published; the daily bound is `requestsPerDay`. Read the
 * live figures from AI Studio before enabling the lane.
 */
export const GEMINI_FLASH: ModelAllowance = {
  id: "gemini-3-flash",
  provider: "gemini",
  role: "reader",
  tokensPerDay: null,
  tokensPerMinute: 250_000,
  contextWindow: 1_048_576,
  requestsPerDay: 1_500,
  sourceUrl: "https://ai.google.dev/gemini-api/docs/rate-limits",
  verifiedOn: "unconfirmed",
};

/**
 * The scout. Verified on OpenRouter's own model and rate-limit pages.
 *
 * This is the only free endpoint confirmed to hold an entire account in one
 * request: a 1,048,576-token window at zero cost for both prompt and
 * completion. Critically, the free tier meters REQUESTS, not tokens, so a
 * single large request is the efficient shape and 50/day is the real ceiling.
 * No tokens-per-minute figure is published, hence null.
 *
 * Fragility to keep in view: free endpoints on this surface are spare provider
 * capacity offered as a marketing or data-collection channel. The roster
 * changes without notice, so the lane must degrade to deterministic-only
 * rather than assume this model exists.
 */
export const OPENROUTER_QWEN_CODER: ModelAllowance = {
  id: "qwen/qwen3-coder:free",
  provider: "openrouter",
  role: "reader",
  tokensPerDay: null,
  tokensPerMinute: null,
  contextWindow: 1_048_576,
  requestsPerDay: 50,
  sourceUrl: "https://openrouter.ai/qwen/qwen3-coder:free",
  verifiedOn: "2026-08-21",
};

/**
 * The council: one reader, two judges from different model families.
 *
 * Gemini stays defined but out of the default council until its limits are
 * read from AI Studio. Depending on one unverified allowance would make the
 * whole lane's capacity a guess.
 */
export const COUNCIL: readonly ModelAllowance[] = [
  OPENROUTER_QWEN_CODER,
  GROQ_QWEN,
  GROQ_GPT_OSS,
];

/** True when a limit came from a primary source a human actually read. */
export function isVerified(model: ModelAllowance): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(model.verifiedOn);
}
