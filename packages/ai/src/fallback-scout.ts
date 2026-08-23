import type { AiScoutResponse } from "@app/contracts";
import type { ScoutPort, ScoutRequest } from "./ports.js";

/**
 * Tries one reader, then the next.
 *
 * The best free reader available is usually an unbranded preview that can be
 * withdrawn without notice. Pointing production at one directly is a bet that
 * it survives the week, and the failure is quiet: the port throws, the funnel
 * reports `ai_not_run`, every scan silently loses its AI pass, and nobody finds
 * out until someone reads a report closely.
 *
 * A chain makes that a non-event. The preferred reader is used while it exists
 * and a stable one takes over the moment it does not, at no cost on the happy
 * path because the fallback is only called after a failure.
 *
 * Deliberately not a retry of the same model. Retrying a model that returned a
 * bad document usually returns another bad document, and the whole point is to
 * survive a model that has stopped existing.
 */
export class FallbackScout implements ScoutPort {
  readonly #chain: readonly ScoutPort[];
  readonly #onFallback: ((index: number) => void) | undefined;

  constructor(
    chain: readonly ScoutPort[],
    onFallback?: (index: number) => void,
  ) {
    if (chain.length === 0) {
      throw new Error("a scout chain needs at least one reader");
    }
    this.#chain = chain;
    this.#onFallback = onFallback;
  }

  async analyze(request: ScoutRequest): Promise<AiScoutResponse> {
    let lastError: unknown;
    for (const [index, scout] of this.#chain.entries()) {
      try {
        return await scout.analyze(request);
      } catch (error) {
        lastError = error;
        // Reported rather than swallowed: a chain that is quietly running on
        // its last link looks identical to one running on its first.
        if (index + 1 < this.#chain.length) this.#onFallback?.(index);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("every scout in the chain failed");
  }
}
