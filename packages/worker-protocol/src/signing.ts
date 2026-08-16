const encoder = new TextEncoder();

export const WORKER_AUTH_VERSION = "v1";
export const WORKER_AUTH_MAX_SKEW_MS = 120_000;

export const WORKER_AUTH_HEADERS = {
  workerId: "x-worker-id",
  keyGeneration: "x-key-generation",
  timestampMs: "x-timestamp-ms",
  signature: "x-signature",
} as const;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(message)),
  );
}

export async function sha256Hex(body: string): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body))),
  );
}

export function workerAuthCanonicalString(input: {
  readonly method: string;
  readonly path: string;
  readonly workerId: string;
  readonly timestampMs: number;
  readonly bodySha256: string;
}): string {
  return [
    WORKER_AUTH_VERSION,
    input.method.toUpperCase(),
    input.path,
    input.workerId,
    String(input.timestampMs),
    input.bodySha256,
  ].join("\n");
}

/** Derive once during worker provisioning; the master secret never leaves control. */
export async function deriveWorkerSecret(
  masterSecret: string,
  workerId: string,
  keyGeneration: number,
): Promise<string> {
  if (masterSecret.length < 32 || !Number.isSafeInteger(keyGeneration) || keyGeneration < 1) {
    throw new Error("invalid worker key material");
  }
  return toBase64Url(
    await hmac(
      masterSecret,
      `${WORKER_AUTH_VERSION}\nworker-secret\n${workerId}\n${keyGeneration}`,
    ),
  );
}

export async function signWorkerRequest(input: {
  readonly workerSecret: string;
  readonly method: string;
  readonly path: string;
  readonly workerId: string;
  readonly timestampMs: number;
  readonly body: string;
}): Promise<string> {
  const canonical = workerAuthCanonicalString({
    method: input.method,
    path: input.path,
    workerId: input.workerId,
    timestampMs: input.timestampMs,
    bodySha256: await sha256Hex(input.body),
  });
  return toBase64Url(await hmac(input.workerSecret, canonical));
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
