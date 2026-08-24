import type { AiScoutResponse } from "@app/contracts";
import type { ScoutPort, ScoutRequest } from "./ports.js";

/**
 * Tries one reader, then the next, with one bounded retry for transient
 * failures.
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
 * Retry is for transient failures only: a rate limit, a 5xx, a dropped
 * connection. On a live scan the reader failed on two of its three slots in
 * exactly this way, free-tier congestion, and a single short wait would have
 * recovered both. A model that returned a bad document is still never
 * retried: another request usually returns another bad document, and a
 * revoked key never fixes itself. The failure kind is read from the error's
 * `kind` property by convention, so this package needs no dependency on the
 * provider package that throws it; an error without a kind is treated as
 * final.
 */

/** Failure kinds worth one more attempt, by the provider error convention. */
const TRANSIENT_KINDS = new Set(["rate_limited", "server", "network"]);

function transientKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("kind" in error)) {
    return null;
  }
  const kind = (error).kind;
  return typeof kind === "string" && TRANSIENT_KINDS.has(kind) ? kind : null;
}

export interface FallbackScoutOptions {
  /** Delay before the one retry of a transient failure. */
  readonly retryDelayMs?: number;
  /** Delay when the transient failure was a rate limit, which needs longer. */
  readonly rateLimitDelayMs?: number;
  /** Injected for tests; real callers sleep. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Called with the last error once every link and retry is spent. */
  readonly onExhausted?: (error: unknown) => void;
}

export class FallbackScout implements ScoutPort {
  readonly #chain: readonly ScoutPort[];
  readonly #onFallback: ((index: number) => void) | undefined;
  readonly #retryDelayMs: number;
  readonly #rateLimitDelayMs: number;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #onExhausted: ((error: unknown) => void) | undefined;

  constructor(
    chain: readonly ScoutPort[],
    onFallback?: (index: number) => void,
    options?: FallbackScoutOptions,
  ) {
    if (chain.length === 0) {
      throw new Error("a scout chain needs at least one reader");
    }
    this.#chain = chain;
    this.#onFallback = onFallback;
    this.#retryDelayMs = options?.retryDelayMs ?? 5_000;
    this.#rateLimitDelayMs = options?.rateLimitDelayMs ?? 20_000;
    this.#wait =
      options?.wait ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#onExhausted = options?.onExhausted;
  }

  async analyze(request: ScoutRequest): Promise<AiScoutResponse> {
    let lastError: unknown;
    for (const [index, scout] of this.#chain.entries()) {
      // At most two attempts per link, and only when the first failure was
      // transient. Everything else falls through to the next reader at once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await scout.analyze(request);
        } catch (error) {
          lastError = error;
          const kind = transientKind(error);
          if (attempt === 0 && kind !== null) {
            await this.#wait(
              kind === "rate_limited"
                ? this.#rateLimitDelayMs
                : this.#retryDelayMs,
            );
            continue;
          }
          break;
        }
      }
      // Reported rather than swallowed: a chain that is quietly running on
      // its last link looks identical to one running on its first.
      if (index + 1 < this.#chain.length) this.#onFallback?.(index);
    }
    this.#onExhausted?.(lastError);
    throw lastError instanceof Error
      ? lastError
      : new Error("every scout in the chain failed");
  }
}
