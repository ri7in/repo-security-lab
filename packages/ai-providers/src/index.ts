import type { JudgePort, ScoutPort, ScoutRequest } from "@app/ai";
import { branding } from "@app/branding";
import {
  aiJudgeVerdictSchema,
  aiScoutResponseSchema,
  type AiJudgeVerdict,
  type AiScoutResponse,
} from "@app/contracts";

/**
 * Live provider adapters.
 *
 * Both adapters take an injected `fetch`, so every test exercises the real
 * parsing, the real headers and the real failure branches without a network or
 * a key. Neither adapter reads process environment: credentials are passed in
 * by the caller that already decided the lane is authorized to run.
 */

/** Named so a provider sees a real client, never a bare runtime default. */
const USER_AGENT = `${branding.productSlug}/1.0`;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "unauthorized"
      | "rate_limited"
      | "server"
      | "malformed"
      | "network",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type FetchLike = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

/** Per-request provider filtering. See OpenRouter's data-policy parameter. */
export interface DataPolicy {
  /**
   * When false, the request is restricted to providers that do not train on
   * inputs. Set true only when the site's published disclosure says so.
   */
  readonly allowTrainingProviders: boolean;
}

function classify(status: number): ProviderError["kind"] {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  return "server";
}

/**
 * Extracts the assistant message and parses it as JSON.
 *
 * Models wrap JSON in prose or fences even when told not to, so the first
 * balanced object is extracted rather than trusting the whole string. A
 * response that still fails to parse is a `malformed` error, never a silent
 * empty result, because "the scout found nothing" and "the scout broke" must
 * never look the same to the coverage ledger.
 */
function parseJsonContent(payload: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(payload);
  } catch {
    throw new ProviderError("provider response was not JSON", "malformed");
  }
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError("provider response had no choices", "malformed");
  }
  const content = (
    choices[0] as { message?: { content?: unknown } } | undefined
  )?.message?.content;
  if (typeof content !== "string") {
    throw new ProviderError("provider response had no content", "malformed");
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ProviderError("no JSON object in model content", "malformed");
  }
  const candidate = content.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Models routinely paste multi-line code into a JSON string without
    // escaping it, which is invalid JSON for one specific and repairable
    // reason. Escape raw control characters that appear inside string
    // literals and retry once. Any other malformation still fails loudly:
    // silently accepting broken model output is how bad findings get through.
    try {
      return JSON.parse(escapeControlCharsInStrings(candidate));
    } catch {
      throw new ProviderError("model content was not valid JSON", "malformed");
    }
  }
}

/** Escapes raw newlines/tabs occurring inside JSON string literals. */
function escapeControlCharsInStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && (char === "\n" || char === "\r" || char === "\t")) {
      out += char === "\n" ? "\\n" : char === "\r" ? "\\r" : "\\t";
      continue;
    }
    out += char;
  }
  return out;
}

export interface OpenRouterOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch: FetchLike;
  readonly dataPolicy: DataPolicy;
  readonly timeoutMs?: number;
  /** Sent so OpenRouter can attribute traffic; carries no user data. */
  readonly refererUrl?: string;
  readonly appTitle?: string;
}

/**
 * Pass-1 scout. Reads a whole account in a single request.
 *
 * `provider.data_collection` is always sent explicitly rather than relying on
 * an account default, so the routing policy travels with the request and is
 * visible in code review instead of buried in a dashboard someone changed.
 */
export class OpenRouterScout implements ScoutPort {
  readonly #options: OpenRouterOptions;

  constructor(options: OpenRouterOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("scout requires an API key");
    }
    this.#options = options;
  }

  async analyze(request: ScoutRequest): Promise<AiScoutResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => { controller.abort(); },
      this.#options.timeoutMs ?? 120_000,
    );
    let raw: string;
    try {
      const response = await this.#options.fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#options.apiKey}`,
            "content-type": "application/json",
            ...(this.#options.refererUrl === undefined
              ? {}
              : { "http-referer": this.#options.refererUrl }),
            ...(this.#options.appTitle === undefined
              ? {}
              : { "x-title": this.#options.appTitle }),
          },
          body: JSON.stringify({
            model: this.#options.model,
            temperature: 0,
            response_format: { type: "json_object" },
            provider: {
              data_collection: this.#options.dataPolicy.allowTrainingProviders
                ? "allow"
                : "deny",
            },
            messages: [
              { role: "system", content: request.systemPrompt },
              { role: "user", content: request.userPrompt },
            ],
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new ProviderError(
          `scout provider returned ${String(response.status)}`,
          classify(response.status),
        );
      }
      raw = await response.text();
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("scout provider unreachable", "network");
    } finally {
      clearTimeout(timeout);
    }

    const parsed = aiScoutResponseSchema.safeParse(parseJsonContent(raw));
    if (!parsed.success) {
      throw new ProviderError("scout response failed its schema", "malformed");
    }
    return parsed.data;
  }
}

export interface JudgeOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly family: string;
  readonly endpoint: string;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Pass-2 judge. Sees one flag and its excerpt, never the whole account.
 *
 * Judges are constructed per model family and the funnel refuses to run two of
 * the same family, so a shared blind spot cannot masquerade as agreement.
 */
export class ChatJudge implements JudgePort {
  readonly #options: JudgeOptions;

  constructor(options: JudgeOptions) {
    if (options.apiKey.trim() === "") {
      throw new Error("judge requires an API key");
    }
    this.#options = options;
  }

  get family(): string {
    return this.#options.family;
  }

  async review(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<AiJudgeVerdict> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => { controller.abort(); },
      this.#options.timeoutMs ?? 60_000,
    );
    let raw: string;
    try {
      const response = await this.#options.fetch(this.#options.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#options.apiKey}`,
          "content-type": "application/json",
          // Groq sits behind Cloudflare and answers a default runtime agent
          // with 403 error 1010, so every provider call names itself.
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({
          model: this.#options.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProviderError(
          `judge provider returned ${String(response.status)}`,
          classify(response.status),
        );
      }
      raw = await response.text();
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("judge provider unreachable", "network");
    } finally {
      clearTimeout(timeout);
    }

    const parsed = aiJudgeVerdictSchema.safeParse(parseJsonContent(raw));
    if (!parsed.success) {
      throw new ProviderError("judge response failed its schema", "malformed");
    }
    return parsed.data;
  }
}
