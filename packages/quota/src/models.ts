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
 * Row for this model on 2026-08-24: RPM 30, RPD 1K, TPM 8K, TPD 200K. The
 * binding constraint is tokens, not requests. At 8,000 tokens per minute a
 * Groq free request cannot carry a whole repository, so this model is a judge
 * over single findings and can never be a reader.
 */
export const GROQ_GPT_OSS: ModelAllowance = {
  id: "openai/gpt-oss-120b",
  provider: "groq",
  role: "judge",
  tokensPerDay: 200_000,
  tokensPerMinute: 8_000,
  contextWindow: 131_072,
  requestsPerDay: 1_000,
  sourceUrl: "https://console.groq.com/docs/rate-limits",
  verifiedOn: "2026-08-24",
};

/**
 * The reader, verified on OpenRouter's own model and rate-limit pages.
 *
 * A million-token window at zero cost for both prompt and completion, which is
 * what lets one request carry a whole repository rather than a sampled slice.
 * The free tier meters REQUESTS, not tokens, so no token figures are published
 * and both are null; 50 a day is the documented ceiling below ten dollars of
 * lifetime credit, and taking the lower row is the honest floor for a meter a
 * visitor reads before deciding to wait.
 *
 * The worker actually prefers `stealth/ox-alpha`, which is the sharper reader
 * and also free at a million tokens. It is deliberately NOT registered here:
 * it is an unbranded preview whose id does not end in `:free`, so the
 * documented free-variant caps do not describe it and its real limit is
 * published nowhere. Budgeting on the named fallback is the conservative
 * choice, and it is the model that carries the load the moment the preview
 * disappears.
 */
export const OPENROUTER_NEMOTRON: ModelAllowance = {
  id: "nvidia/nemotron-3-ultra-550b-a55b:free",
  provider: "openrouter",
  role: "reader",
  tokensPerDay: null,
  tokensPerMinute: null,
  contextWindow: 1_000_000,
  requestsPerDay: 50,
  sourceUrl: "https://openrouter.ai/docs/api-reference/limits",
  verifiedOn: "2026-08-24",
};

/**
 * Gemini, defined but out of the budget.
 *
 * Google's rate-limit page no longer publishes a per-model free-tier table; it
 * says to read the active limits in AI Studio. That makes any number here a
 * guess, and this file does not carry guesses, so the model stays out of the
 * council budget even though the worker runs it as a second judge. The cost of
 * that is understated scarcity if Gemini is the first to run out, and the
 * funnel already reports a judge it could not reach as a partial review rather
 * than a clean one.
 */
export const GEMINI_FLASH_LITE: ModelAllowance = {
  id: "gemini-flash-lite-latest",
  provider: "gemini",
  role: "judge",
  tokensPerDay: null,
  tokensPerMinute: null,
  contextWindow: 1_048_576,
  requestsPerDay: 0,
  sourceUrl: "https://ai.google.dev/gemini-api/docs/rate-limits",
  verifiedOn: "unconfirmed",
};

/**
 * The council as the worker actually runs it, minus what cannot be verified.
 *
 * Every id here is one the scan worker really calls, which was not true
 * before: the budget was computed from a reader OpenRouter has since removed
 * and a judge the worker never used, so the figure on the landing page was
 * arithmetic on models that were not doing the work.
 */
export const COUNCIL: readonly ModelAllowance[] = [
  OPENROUTER_NEMOTRON,
  GROQ_GPT_OSS,
];

/**
 * Every provider that can receive repository source, budgeted or not.
 *
 * The footer named `COUNCIL`'s providers, and Gemini is deliberately absent
 * from COUNCIL because its free limits are no longer published. So the page
 * disclosed OpenRouter and Groq while a second judge on Google was reading
 * code excerpts on every scan. A provider being unbudgetable is not a reason
 * to leave it out of the disclosure; if anything it is the opposite.
 */
export const DISCLOSED_PROVIDERS: readonly ModelAllowance["provider"][] = [
  "openrouter",
  "groq",
  "gemini",
];

/** True when a limit came from a primary source a human actually read. */
export function isVerified(model: ModelAllowance): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(model.verifiedOn);
}
