import { opaqueIdSchema, type OpaqueId } from "@app/contracts";
import type { D1Database } from "@app/store-d1";
import {
  WORKER_AUTH_HEADERS,
  WORKER_AUTH_MAX_SKEW_MS,
  deriveWorkerSecret,
  signWorkerRequest,
  timingSafeEqual,
} from "@app/worker-protocol";

interface WorkerIdentityRow {
  worker_id: string;
  key_generation: number;
  status: string;
}

export type WorkerAuthentication =
  | { readonly ok: true; readonly workerId: OpaqueId }
  | { readonly ok: false; readonly reason: "AUTH_REQUIRED" | "AUTH_INVALID" };

export async function authenticateWorkerRequest(input: {
  readonly request: Request;
  readonly body: string;
  readonly database: D1Database;
  readonly masterSecret: string;
  readonly nowMs: number;
}): Promise<WorkerAuthentication> {
  const workerId = input.request.headers.get(WORKER_AUTH_HEADERS.workerId);
  const generationText = input.request.headers.get(
    WORKER_AUTH_HEADERS.keyGeneration,
  );
  const timestampText = input.request.headers.get(WORKER_AUTH_HEADERS.timestampMs);
  const signature = input.request.headers.get(WORKER_AUTH_HEADERS.signature);
  if (
    workerId === null ||
    generationText === null ||
    timestampText === null ||
    signature === null
  ) {
    return { ok: false, reason: "AUTH_REQUIRED" };
  }
  if (
    !opaqueIdSchema.safeParse(workerId).success ||
    !/^[1-9][0-9]{0,9}$/.test(generationText) ||
    !/^(?:0|[1-9][0-9]{0,15})$/.test(timestampText) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
    input.masterSecret.length < 32
  ) {
    return { ok: false, reason: "AUTH_INVALID" };
  }
  const keyGeneration = Number(generationText);
  const timestampMs = Number(timestampText);
  if (
    !Number.isSafeInteger(keyGeneration) ||
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(input.nowMs - timestampMs) > WORKER_AUTH_MAX_SKEW_MS
  ) {
    return { ok: false, reason: "AUTH_INVALID" };
  }
  const row = await input.database
    .prepare(
      `SELECT worker_id, key_generation, status FROM worker_identities
       WHERE worker_id = ?`,
    )
    .bind(workerId)
    .first<WorkerIdentityRow>();
  if (
    row === null ||
    row.status !== "active" ||
    row.key_generation !== keyGeneration ||
    row.worker_id !== workerId
  ) {
    return { ok: false, reason: "AUTH_INVALID" };
  }
  const url = new URL(input.request.url);
  const workerSecret = await deriveWorkerSecret(
    input.masterSecret,
    workerId,
    keyGeneration,
  );
  const expected = await signWorkerRequest({
    workerSecret,
    method: input.request.method,
    path: url.pathname,
    workerId,
    timestampMs,
    body: input.body,
  });
  return timingSafeEqual(signature, expected)
    ? { ok: true, workerId }
    : { ok: false, reason: "AUTH_INVALID" };
}
