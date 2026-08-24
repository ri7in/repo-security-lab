import { opaqueIdSchema, type OpaqueId } from "@app/contracts";
import type {
  FinalizeExhaustedInput,
  HeartbeatInput,
  PublicationResult,
  PublishInput,
  ReleaseInput,
  RepositoryRecord,
  ScanRequestRecord,
  TransitionInput,
  WorkerStorePort,
} from "@app/core";
import {
  WORKER_AUTH_HEADERS,
  WORKER_PROTOCOL_PATHS,
  booleanResultSchema,
  claimResponseSchema,
  classifyExpiredResponseSchema,
  protocolErrorSchema,
  publicationResponseSchema,
  requestResponseSchema,
  signWorkerRequest,
} from "@app/worker-protocol";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 2_097_152;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface HttpWorkerStoreOptions {
  readonly baseUrl: string;
  readonly workerId: OpaqueId;
  readonly keyGeneration: number;
  readonly workerSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  /** Local workerd tests only. Production endpoints must use HTTPS. */
  readonly allowInsecureLocalhost?: boolean;
}

async function readBounded(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error("control plane response invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("control plane response invalid");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(decoder.decode(bytes)) as unknown;
}

function checkedBaseUrl(raw: string, allowInsecureLocalhost: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid control plane URL");
  }
  const local =
    allowInsecureLocalhost &&
    url.protocol === "http:" &&
    ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("invalid control plane URL");
  }
  return url.origin;
}

export class HttpWorkerStore implements WorkerStorePort {
  readonly #baseUrl: string;
  readonly #workerId: OpaqueId;
  readonly #keyGeneration: number;
  readonly #workerSecret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;

  constructor(options: HttpWorkerStoreOptions) {
    if (!opaqueIdSchema.safeParse(options.workerId).success) {
      throw new Error("invalid worker identity");
    }
    if (!Number.isSafeInteger(options.keyGeneration) || options.keyGeneration < 1) {
      throw new Error("invalid worker key generation");
    }
    if (options.workerSecret.length < 32 || options.workerSecret.length > 256) {
      throw new Error("invalid worker secret");
    }
    this.#baseUrl = checkedBaseUrl(
      options.baseUrl,
      options.allowInsecureLocalhost ?? false,
    );
    this.#workerId = options.workerId;
    this.#keyGeneration = options.keyGeneration;
    this.#workerSecret = options.workerSecret;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > 120_000
    ) {
      throw new Error("invalid control plane timeout");
    }
  }

  async #request(path: string, payload?: unknown): Promise<unknown> {
    const method = payload === undefined ? "GET" : "POST";
    const body = payload === undefined ? "" : JSON.stringify(payload);
    if (encoder.encode(body).byteLength > MAX_REQUEST_BYTES) {
      throw new Error("control plane request too large");
    }
    const timestampMs = this.#now();
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
      throw new Error("invalid worker clock");
    }
    const signature = await signWorkerRequest({
      workerSecret: this.#workerSecret,
      method,
      path,
      workerId: this.#workerId,
      timestampMs,
      body,
    });
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        [WORKER_AUTH_HEADERS.workerId]: this.#workerId,
        [WORKER_AUTH_HEADERS.keyGeneration]: String(this.#keyGeneration),
        [WORKER_AUTH_HEADERS.timestampMs]: String(timestampMs),
        [WORKER_AUTH_HEADERS.signature]: signature,
      },
      ...(payload === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    const parsed = await readBounded(response);
    if (!response.ok) {
      const error = protocolErrorSchema.safeParse(parsed);
      throw new Error(
        error.success
          ? `control plane rejected request: ${error.data.reason}`
          : "control plane request failed",
      );
    }
    return parsed;
  }

  async getRequest(requestId: OpaqueId): Promise<ScanRequestRecord | null> {
    if (!opaqueIdSchema.safeParse(requestId).success) {
      throw new Error("invalid request id");
    }
    const body = requestResponseSchema.parse(
      await this.#request(`/internal/v1/requests/${requestId}`),
    );
    return body.request;
  }

  async claimNext(input: {
    readonly workerId: OpaqueId;
    readonly nowMs: number;
    readonly leaseDurationMs: number;
  }): Promise<RepositoryRecord | null> {
    this.#assertWorker(input.workerId);
    const body = claimResponseSchema.parse(
      await this.#request(WORKER_PROTOCOL_PATHS.claim, {
        leaseDurationMs: input.leaseDurationMs,
      }),
    );
    if (body.repository === null) return null;
    // A control plane deployed before the deep-read mark sends no aiEligible
    // key at all; the record type spells that "null", never "undefined".
    return { ...body.repository, aiEligible: body.repository.aiEligible ?? null };
  }

  async heartbeat(input: HeartbeatInput): Promise<boolean> {
    this.#assertWorker(input.workerId);
    return booleanResultSchema.parse(
      await this.#request(WORKER_PROTOCOL_PATHS.heartbeat, {
        requestId: input.requestId,
        repositoryId: input.repositoryId,
        generation: input.generation,
        leaseDurationMs: input.leaseDurationMs,
      }),
    ).result;
  }

  async classifyExpiredLeases(nowMs: number) {
    void nowMs;
    return classifyExpiredResponseSchema.parse(
      await this.#request(WORKER_PROTOCOL_PATHS.classifyExpired, {}),
    );
  }

  async requeueCleaned(input: FinalizeExhaustedInput): Promise<boolean> {
    return this.#leaseBoolean(WORKER_PROTOCOL_PATHS.requeueCleaned, input);
  }

  async finalizeExhausted(input: FinalizeExhaustedInput): Promise<boolean> {
    return this.#leaseBoolean(WORKER_PROTOCOL_PATHS.finalizeExhausted, input);
  }

  async retryCleaned(input: ReleaseInput): Promise<boolean> {
    this.#assertWorker(input.workerId);
    return this.#leaseBoolean(WORKER_PROTOCOL_PATHS.retryCleaned, input);
  }

  async transition(input: TransitionInput): Promise<boolean> {
    this.#assertWorker(input.workerId);
    return booleanResultSchema.parse(
      await this.#request(WORKER_PROTOCOL_PATHS.transition, {
        requestId: input.requestId,
        repositoryId: input.repositoryId,
        generation: input.generation,
        expectedState: input.expectedState,
        nextState: input.nextState,
      }),
    ).result;
  }

  async publish(input: PublishInput): Promise<PublicationResult> {
    this.#assertWorker(input.workerId);
    return publicationResponseSchema.parse(
      await this.#request(WORKER_PROTOCOL_PATHS.publish, {
        requestId: input.requestId,
        repositoryId: input.repositoryId,
        generation: input.generation,
        terminalState: input.terminalState,
        reason: input.reason,
        coverage: input.coverage,
        specialistReasons: input.specialistReasons,
        findings: input.findings,
      }),
    ).result;
  }

  async #leaseBoolean(
    path: string,
    input: FinalizeExhaustedInput | ReleaseInput,
  ): Promise<boolean> {
    if ("workerId" in input) this.#assertWorker(input.workerId);
    return booleanResultSchema.parse(
      await this.#request(path, {
        requestId: input.requestId,
        repositoryId: input.repositoryId,
        generation: input.generation,
      }),
    ).result;
  }

  #assertWorker(workerId: OpaqueId): void {
    if (workerId !== this.#workerId) throw new Error("worker identity mismatch");
  }
}
