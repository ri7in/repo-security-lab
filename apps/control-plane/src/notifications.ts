import { opaqueIdSchema, type OpaqueId } from "@app/contracts";
import type { D1Database } from "@app/store-d1";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DAY_MS = 24 * 60 * 60 * 1_000;
const CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_DAILY_NOTIFICATIONS = 80;
const MAX_ATTEMPTS = 3;

export interface NotificationEnvironment {
  readonly NOTIFICATION_DATA_SECRET?: string;
  readonly NOTIFICATION_RELAY_SECRET?: string;
  readonly NOTIFICATION_RELAY_URL?: string;
  readonly PUBLIC_APP_ORIGIN?: string;
}

export interface NotificationConfiguration {
  readonly dataSecret: string;
  readonly relaySecret: string;
  readonly relayUrl: string;
  readonly publicAppOrigin: string;
}

interface NotificationRow {
  request_id: string;
  recipient_ciphertext: string;
  recipient_iv: string;
  attempt_count: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid notification data");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function checkedUrl(value: string, originOnly: boolean): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (originOnly && (url.pathname !== "/" || url.search !== ""))
  ) {
    throw new Error("invalid notification URL");
  }
  return originOnly ? url.origin : url.toString();
}

export function notificationConfiguration(
  environment: NotificationEnvironment,
): NotificationConfiguration | null {
  const senderValues = [
    environment.NOTIFICATION_DATA_SECRET,
    environment.NOTIFICATION_RELAY_SECRET,
    environment.NOTIFICATION_RELAY_URL,
  ];
  if (senderValues.every((value) => value === undefined || value === "")) return null;
  if (
    senderValues.some((value) => value === undefined || value === "") ||
    environment.PUBLIC_APP_ORIGIN === undefined ||
    environment.PUBLIC_APP_ORIGIN === ""
  ) {
    throw new Error("incomplete notification configuration");
  }
  const [dataSecret, relaySecret, relayUrl] = senderValues as [
    string,
    string,
    string,
  ];
  const publicAppOrigin = environment.PUBLIC_APP_ORIGIN;
  if (dataSecret.length < 32 || relaySecret.length < 32) {
    throw new Error("invalid notification secret");
  }
  return {
    dataSecret,
    relaySecret,
    relayUrl: checkedUrl(relayUrl, false),
    publicAppOrigin: checkedUrl(publicAppOrigin, true),
  };
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`repo-security-notification-data\0${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))),
  );
}

async function sealRecipient(
  configuration: NotificationConfiguration,
  requestId: OpaqueId,
  email: string,
): Promise<{ readonly hash: string; readonly ciphertext: string; readonly iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(requestId) },
    await deriveAesKey(configuration.dataSecret),
    encoder.encode(email),
  );
  return {
    hash: await hmac(configuration.dataSecret, `recipient\0${email}`),
    ciphertext: base64Url(new Uint8Array(ciphertext)),
    iv: base64Url(iv),
  };
}

async function openRecipient(
  configuration: NotificationConfiguration,
  row: NotificationRow,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ownedBuffer(fromBase64Url(row.recipient_iv)),
      additionalData: encoder.encode(row.request_id),
    },
    await deriveAesKey(configuration.dataSecret),
    ownedBuffer(fromBase64Url(row.recipient_ciphertext)),
  );
  const email = decoder.decode(plaintext);
  if (email.length > 254 || !email.includes("@")) throw new Error("invalid notification data");
  return email;
}

export async function registerNotification(
  database: D1Database,
  configuration: NotificationConfiguration,
  input: { readonly requestId: OpaqueId; readonly email: string; readonly nowMs: number },
): Promise<"queued" | "rate_limited" | "unavailable"> {
  if (
    !opaqueIdSchema.safeParse(input.requestId).success ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0
  ) {
    return "unavailable";
  }
  const sealed = await sealRecipient(configuration, input.requestId, input.email);
  const windowStart = Math.max(0, input.nowMs - DAY_MS);
  const [total, recipient] = await Promise.all([
    database
      .prepare(`SELECT COUNT(*) AS count FROM scan_notifications WHERE created_at_ms >= ?`)
      .bind(windowStart)
      .first<{ count: number }>(),
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM scan_notifications
         WHERE recipient_hash = ? AND created_at_ms >= ?`,
      )
      .bind(sealed.hash, windowStart)
      .first<{ count: number }>(),
  ]);
  if ((total?.count ?? 0) >= MAX_DAILY_NOTIFICATIONS || (recipient?.count ?? 0) >= 1) {
    return "rate_limited";
  }
  try {
    await database
      .prepare(
        `INSERT INTO scan_notifications(
           request_id, recipient_hash, recipient_ciphertext, recipient_iv,
           state, attempt_count, next_attempt_at_ms, claimed_at_ms, sent_at_ms,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        input.requestId,
        sealed.hash,
        sealed.ciphertext,
        sealed.iv,
        input.nowMs,
        input.nowMs,
        input.nowMs,
      )
      .run();
    return "queued";
  } catch {
    return "unavailable";
  }
}

async function readRelayResponse(response: Response): Promise<boolean> {
  if (!response.ok || response.body === null) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > 1_024) {
        await reader.cancel().catch(() => undefined);
        return false;
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
  try {
    const body = JSON.parse(decoder.decode(bytes)) as unknown;
    return (
      typeof body === "object" &&
      body !== null &&
      Object.keys(body).length === 1 &&
      "ok" in body &&
      body.ok === true
    );
  } catch {
    return false;
  }
}

async function finishDelivery(
  database: D1Database,
  row: NotificationRow,
  sent: boolean,
  nowMs: number,
): Promise<void> {
  if (sent) {
    await database
      .prepare(
        `UPDATE scan_notifications
         SET state = 'sent', claimed_at_ms = NULL, sent_at_ms = ?, updated_at_ms = ?,
             recipient_ciphertext = '', recipient_iv = ''
         WHERE request_id = ? AND state = 'sending' AND attempt_count = ?`,
      )
      .bind(nowMs, nowMs, row.request_id, row.attempt_count)
      .run();
    return;
  }
  const terminal = row.attempt_count >= MAX_ATTEMPTS;
  const retryDelay = row.attempt_count <= 1 ? 5 * 60 * 1_000 : 30 * 60 * 1_000;
  await database
    .prepare(
      `UPDATE scan_notifications
       SET state = ?, claimed_at_ms = NULL, next_attempt_at_ms = ?, updated_at_ms = ?,
           recipient_ciphertext = CASE WHEN ? = 'failed' THEN '' ELSE recipient_ciphertext END,
           recipient_iv = CASE WHEN ? = 'failed' THEN '' ELSE recipient_iv END
       WHERE request_id = ? AND state = 'sending' AND attempt_count = ?`,
    )
    .bind(
      terminal ? "failed" : "pending",
      nowMs + retryDelay,
      nowMs,
      terminal ? "failed" : "pending",
      terminal ? "failed" : "pending",
      row.request_id,
      row.attempt_count,
    )
    .run();
}

/** Claims and sends at most one fixed transactional report notification. */
export async function deliverOneNotification(
  database: D1Database,
  configuration: NotificationConfiguration,
  nowMs = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<"idle" | "sent" | "retry" | "failed"> {
  const row = await database
    .prepare(
      `UPDATE scan_notifications
       SET state = 'sending', attempt_count = attempt_count + 1,
           claimed_at_ms = ?, updated_at_ms = ?
       WHERE request_id = (
         SELECT n.request_id
         FROM scan_notifications n
         JOIN scan_requests r ON r.request_id = n.request_id
         WHERE r.state IN ('complete','failed')
           AND n.attempt_count < 3
           AND (
             (n.state = 'pending' AND n.next_attempt_at_ms <= ?) OR
             (n.state = 'sending' AND n.claimed_at_ms <= ?)
           )
         ORDER BY n.created_at_ms, n.request_id
         LIMIT 1
       )
       RETURNING request_id, recipient_ciphertext, recipient_iv, attempt_count`,
    )
    .bind(nowMs, nowMs, nowMs, Math.max(0, nowMs - CLAIM_TIMEOUT_MS))
    .first<NotificationRow>();
  if (row === null) return "idle";

  let sent = false;
  try {
    const recipient = await openRecipient(configuration, row);
    const payload = {
      schemaVersion: 1,
      requestId: row.request_id,
      recipient,
      reportUrl: `${configuration.publicAppOrigin}/?request=${row.request_id}`,
      issuedAtMs: nowMs,
    };
    const canonical = JSON.stringify(payload);
    const signature = await hmac(configuration.relaySecret, canonical);
    const response = await fetchImpl(configuration.relayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, signature }),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    sent = await readRelayResponse(response);
  } catch {
    sent = false;
  }
  await finishDelivery(database, row, sent, nowMs);
  return sent ? "sent" : row.attempt_count >= MAX_ATTEMPTS ? "failed" : "retry";
}
