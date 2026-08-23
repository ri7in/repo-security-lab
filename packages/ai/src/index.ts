/**
 * The AI detection lane.
 *
 * Pass 1 (`OpenRouterScout`) reads a whole account in one request and points at
 * code. A deterministic grounding gate then discards anything the model could
 * not actually have seen. Pass 2 sends survivors to independent judges from
 * different model families, and only a majority "real" reaches a report.
 *
 * Deterministic findings never enter this module. AI output is strictly
 * additive and can neither hide nor downgrade a scanner result.
 */
export * from "./pack.js";
export * from "./grounding.js";
export * from "./ports.js";
export * from "./prompts.js";
export * from "./funnel.js";
export * from "./fallback-scout.js";
export * from "./finding-review.js";
export * from "./fixtures.js";
