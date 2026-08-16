import { opaqueIdSchema, type OpaqueId } from "@app/contracts";
import {
  validatePublishInput,
  type PublishInput,
} from "@app/core";
import { D1Store, type D1Database } from "@app/store-d1";
import {
  WORKER_PROTOCOL_PATHS,
  claimBodySchema,
  heartbeatBodySchema,
  leaseReferenceSchema,
  publishBodySchema,
  transitionBodySchema,
} from "@app/worker-protocol";
import { ZodError } from "zod";
import { authenticateWorkerRequest } from "./worker-auth.js";

const DEFAULT_MAX_BODY_BYTES = 16_384;
const MAX_PUBLISH_BODY_BYTES = 1_048_576;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface InternalApiEnvironment {
  readonly DB: D1Database;
  readonly WORKER_AUTH_MASTER_SECRET: string;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function readBody(request: Request, limit: number): Promise<string> {
  if (request.method === "GET") {
    if (request.body !== null) throw new Error("invalid body");
    return "";
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  const contentEncoding = request.headers.get("content-encoding");
  const declaredLength = request.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (contentEncoding !== null && contentEncoding !== "identity") ||
    request.body === null ||
    (declaredLength !== null &&
      (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > limit))
  ) {
    throw new Error("invalid body");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("invalid body");
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
  return decoder.decode(bytes);
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

function publication(
  parsed: ReturnType<typeof publishBodySchema.parse>,
  workerId: OpaqueId,
  nowMs: number,
): PublishInput | null {
  const common = {
    requestId: parsed.requestId,
    repositoryId: parsed.repositoryId,
    workerId,
    generation: parsed.generation,
    coverage: parsed.coverage,
    specialistReasons: parsed.specialistReasons,
    findings: parsed.findings,
    nowMs,
  };
  if (parsed.terminalState === "complete") {
    return parsed.reason === null
      ? { ...common, terminalState: "complete", reason: null }
      : null;
  }
  return parsed.reason === null
    ? null
    : { ...common, terminalState: parsed.terminalState, reason: parsed.reason };
}

export async function handleInternalRequest(
  request: Request,
  environment: InternalApiEnvironment,
  nowMs = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  if (url.search !== "" || url.hash !== "") {
    return response({ reason: "NOT_FOUND" }, 404);
  }
  const requestMatch = /^\/internal\/v1\/requests\/([A-Za-z0-9_-]{8,64})$/.exec(
    url.pathname,
  );
  const knownPostPath = Object.values(WORKER_PROTOCOL_PATHS).includes(
    url.pathname as (typeof WORKER_PROTOCOL_PATHS)[keyof typeof WORKER_PROTOCOL_PATHS],
  );
  if (
    (request.method !== "GET" || requestMatch === null) &&
    (request.method !== "POST" || !knownPostPath)
  ) {
    return response({ reason: "NOT_FOUND" }, 404);
  }
  let body: string;
  try {
    body = await readBody(
      request,
      url.pathname === WORKER_PROTOCOL_PATHS.publish
        ? MAX_PUBLISH_BODY_BYTES
        : DEFAULT_MAX_BODY_BYTES,
    );
  } catch {
    return response({ reason: "INVALID_BODY" }, 400);
  }
  let authentication;
  try {
    authentication = await authenticateWorkerRequest({
      request,
      body,
      database: environment.DB,
      masterSecret: environment.WORKER_AUTH_MASTER_SECRET,
      nowMs,
    });
  } catch {
    return response({ reason: "INTERNAL_ERROR" }, 500);
  }
  if (!authentication.ok) {
    return response(
      { reason: authentication.reason },
      authentication.reason === "AUTH_REQUIRED" ? 401 : 403,
    );
  }
  const store = new D1Store(environment.DB);
  try {
    if (requestMatch !== null) {
      const requestId = requestMatch[1];
      if (requestId === undefined || !opaqueIdSchema.safeParse(requestId).success) {
        return response({ reason: "NOT_FOUND" }, 404);
      }
      return response({ request: await store.getRequest(requestId) });
    }
    const value = parseJson(body);
    if (url.pathname === WORKER_PROTOCOL_PATHS.claim) {
      const parsed = claimBodySchema.parse(value);
      return response({
        repository: await store.claimNextForWorker({
          workerId: authentication.workerId,
          nowMs,
          leaseDurationMs: parsed.leaseDurationMs,
        }),
      });
    }
    if (url.pathname === WORKER_PROTOCOL_PATHS.heartbeat) {
      const parsed = heartbeatBodySchema.parse(value);
      return response({
        result: await store.heartbeat({
          ...parsed,
          workerId: authentication.workerId,
          nowMs,
        }),
      });
    }
    if (url.pathname === WORKER_PROTOCOL_PATHS.classifyExpired) {
      if (typeof value !== "object" || value === null || Object.keys(value).length !== 0) {
        return response({ reason: "INVALID_BODY" }, 400);
      }
      return response(
        await store.classifyExpiredLeasesForWorker(
          nowMs,
          authentication.workerId,
        ),
      );
    }
    if (
      url.pathname === WORKER_PROTOCOL_PATHS.requeueCleaned ||
      url.pathname === WORKER_PROTOCOL_PATHS.finalizeExhausted ||
      url.pathname === WORKER_PROTOCOL_PATHS.retryCleaned
    ) {
      const parsed = leaseReferenceSchema.parse(value);
      const result =
        url.pathname === WORKER_PROTOCOL_PATHS.requeueCleaned
          ? await store.requeueCleanedForWorker(
              { ...parsed, nowMs },
              authentication.workerId,
            )
          : url.pathname === WORKER_PROTOCOL_PATHS.finalizeExhausted
            ? await store.finalizeExhaustedForWorker(
                { ...parsed, nowMs },
                authentication.workerId,
              )
            : await store.retryCleaned({
                ...parsed,
                workerId: authentication.workerId,
                nowMs,
              });
      return response({ result });
    }
    if (url.pathname === WORKER_PROTOCOL_PATHS.transition) {
      const parsed = transitionBodySchema.parse(value);
      return response({
        result: await store.transition({
          ...parsed,
          workerId: authentication.workerId,
          nowMs,
        }),
      });
    }
    if (url.pathname === WORKER_PROTOCOL_PATHS.publish) {
      const parsed = publishBodySchema.parse(value);
      const input = publication(parsed, authentication.workerId, nowMs);
      if (input === null) return response({ reason: "INVALID_BODY" }, 400);
      try {
        validatePublishInput(input);
      } catch {
        return response({ reason: "INVALID_BODY" }, 400);
      }
      return response({ result: await store.publish(input) });
    }
    return response({ reason: "NOT_FOUND" }, 404);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return response({ reason: "INVALID_BODY" }, 400);
    }
    return response({ reason: "INTERNAL_ERROR" }, 500);
  }
}
