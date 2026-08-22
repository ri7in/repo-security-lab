import type { AiJudgeVerdict, AiScoutResponse } from "@app/contracts";

/**
 * Ports the funnel depends on.
 *
 * These interfaces live here, but no implementation that touches a network
 * may. `packages/ai` is structurally network-blind and an import-boundary test
 * enforces it, so the fetch-based adapters live in `@app/ai-providers` and are
 * injected. The funnel therefore cannot reach a provider by accident, only by
 * being handed one.
 */

export interface ScoutRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface ScoutPort {
  analyze(request: ScoutRequest): Promise<AiScoutResponse>;
}

export interface JudgePort {
  readonly family: string;
  review(systemPrompt: string, userPrompt: string): Promise<AiJudgeVerdict>;
}
