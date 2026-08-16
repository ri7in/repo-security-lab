import {
  opaqueIdSchema,
  operatorFindingPageSchema,
  type OpaqueId,
} from "@app/contracts";
import type { Store } from "@app/core";
import { timingSafeEqual } from "@app/worker-protocol";
import { z } from "zod";

const STATE_COOKIE = "__Host-owner_oauth_state";
const SESSION_COOKIE = "__Host-owner_session";
const STATE_LIFETIME_MS = 10 * 60 * 1_000;
const SESSION_LIFETIME_MS = 60 * 60 * 1_000;
const MAX_GITHUB_RESPONSE_BYTES = 32_768;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const oauthResponseSchema = z.strictObject({
  access_token: z.string().min(20).max(255).regex(/^[A-Za-z0-9_]+$/),
  token_type: z.literal("bearer"),
  scope: z.literal(""),
});

const githubUserSchema = z.object({
  id: z.number().int().nonnegative().safe(),
  login: z.string().min(1).max(39),
  type: z.literal("User"),
});

const oauthStateSchema = z.strictObject({
  version: z.literal(1),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  requestId: opaqueIdSchema,
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
});

const ownerSessionSchema = z.strictObject({
  version: z.literal(1),
  githubAccountId: z.number().int().nonnegative().safe(),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
});

interface OwnerAuthEnvironment {
  readonly GITHUB_OAUTH_CLIENT_ID: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET: string;
  readonly OWNER_SESSION_SECRET: string;
}

export interface OwnerRequestOptions {
  readonly request: Request;
  readonly environment: OwnerAuthEnvironment;
  readonly store: Store;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid token");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<string> {
  if (secret.length < 32) throw new Error("invalid session secret");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
  );
}

async function signedToken(payload: unknown, secret: string): Promise<string> {
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(secret, encoded)}`;
}

async function verifiedToken(
  token: string,
  secret: string,
): Promise<unknown> {
  const [encoded, signature, extra] = token.split(".");
  if (encoded === undefined || signature === undefined || extra !== undefined) {
    throw new Error("invalid token");
  }
  const expected = await hmac(secret, encoded);
  if (!timingSafeEqual(signature, expected)) throw new Error("invalid token");
  return JSON.parse(decoder.decode(fromBase64Url(encoded))) as unknown;
}

function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
    ),
  );
}

function cookies(request: Request): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!values.has(key)) values.set(key, value);
  }
  return values;
}

function secureCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function readGithubJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error("invalid GitHub response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_GITHUB_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("invalid GitHub response");
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

async function revokeOauthToken(
  fetchImpl: typeof fetch,
  environment: OwnerAuthEnvironment,
  accessToken: string,
): Promise<boolean> {
  const basic = btoa(
    `${environment.GITHUB_OAUTH_CLIENT_ID}:${environment.GITHUB_OAUTH_CLIENT_SECRET}`,
  );
  const response = await fetchImpl(
    `https://api.github.com/applications/${encodeURIComponent(environment.GITHUB_OAUTH_CLIENT_ID)}/token`,
    {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "user-agent": "repository-security-service",
        "x-github-api-version": "2026-03-10",
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  return response.status === 204;
}

function oauthConfigured(environment: OwnerAuthEnvironment): boolean {
  return (
    environment.GITHUB_OAUTH_CLIENT_ID.length > 0 &&
    environment.GITHUB_OAUTH_CLIENT_ID.length <= 200 &&
    environment.GITHUB_OAUTH_CLIENT_SECRET.length >= 20 &&
    environment.OWNER_SESSION_SECRET.length >= 32
  );
}

async function start(options: OwnerRequestOptions, requestId: OpaqueId): Promise<Response> {
  if (!oauthConfigured(options.environment)) {
    return json({ reason: "OWNER_AUTH_UNAVAILABLE" }, 503);
  }
  const scanRequest = await options.store.getRequest(requestId);
  if (scanRequest === null) return json({ reason: "NOT_FOUND" }, 404);
  const nowMs = options.nowMs ?? Date.now();
  const state = randomToken();
  const verifier = randomToken(48);
  const stateToken = await signedToken(
    {
      version: 1,
      state,
      verifier,
      requestId,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + STATE_LIFETIME_MS,
    },
    options.environment.OWNER_SESSION_SECRET,
  );
  const callback = `${new URL(options.request.url).origin}/auth/github/callback`;
  const destination = new URL("https://github.com/login/oauth/authorize");
  destination.searchParams.set("client_id", options.environment.GITHUB_OAUTH_CLIENT_ID);
  destination.searchParams.set("redirect_uri", callback);
  destination.searchParams.set("scope", "");
  destination.searchParams.set("state", state);
  destination.searchParams.set("code_challenge", await pkceChallenge(verifier));
  destination.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers({
    location: destination.href,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", secureCookie(STATE_COOKIE, stateToken, 600));
  return new Response(null, { status: 302, headers });
}

async function callback(options: OwnerRequestOptions): Promise<Response> {
  if (!oauthConfigured(options.environment)) {
    return json({ reason: "OWNER_AUTH_UNAVAILABLE" }, 503);
  }
  const url = new URL(options.request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const stateCookie = cookies(options.request).get(STATE_COOKIE);
  if (
    code === null ||
    returnedState === null ||
    stateCookie === undefined ||
    !/^[A-Za-z0-9_-]{8,255}$/.test(code)
  ) {
    return json({ reason: "OWNER_AUTH_INVALID" }, 400);
  }
  let state;
  try {
    state = oauthStateSchema.parse(
      await verifiedToken(stateCookie, options.environment.OWNER_SESSION_SECRET),
    );
  } catch {
    return json({ reason: "OWNER_AUTH_INVALID" }, 400);
  }
  const nowMs = options.nowMs ?? Date.now();
  if (
    state.state !== returnedState ||
    state.expiresAtMs < nowMs ||
    state.issuedAtMs > nowMs
  ) {
    return json({ reason: "OWNER_AUTH_INVALID" }, 400);
  }
  const callbackUrl = `${url.origin}/auth/github/callback`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenResponse = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "repository-security-service",
    },
    body: new URLSearchParams({
      client_id: options.environment.GITHUB_OAUTH_CLIENT_ID,
      client_secret: options.environment.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
      code_verifier: state.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) return json({ reason: "OWNER_AUTH_FAILED" }, 502);
  const token = oauthResponseSchema.safeParse(await readGithubJson(tokenResponse));
  if (!token.success) return json({ reason: "OWNER_AUTH_FAILED" }, 502);
  let user: z.infer<typeof githubUserSchema> | null = null;
  try {
    const userResponse = await fetchImpl("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.data.access_token}`,
        "user-agent": "repository-security-service",
        "x-github-api-version": "2026-03-10",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (userResponse.ok) {
      const parsed = githubUserSchema.safeParse(await readGithubJson(userResponse));
      if (parsed.success) user = parsed.data;
    }
  } catch {
    user = null;
  }
  let revoked = false;
  try {
    revoked = await revokeOauthToken(
      fetchImpl,
      options.environment,
      token.data.access_token,
    );
  } catch {
    revoked = false;
  }
  if (!revoked || user === null) {
    return json({ reason: "OWNER_AUTH_FAILED" }, 502);
  }
  const scanRequest = await options.store.getRequest(state.requestId);
  if (
    scanRequest?.githubAccountId === null ||
    scanRequest === null ||
    scanRequest.githubAccountId !== user.id
  ) {
    return json({ reason: "OWNER_MISMATCH" }, 403);
  }
  const session = await signedToken(
    {
      version: 1,
      githubAccountId: user.id,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + SESSION_LIFETIME_MS,
    },
    options.environment.OWNER_SESSION_SECRET,
  );
  const destination = new URL("/", url.origin);
  destination.searchParams.set("request", state.requestId);
  destination.searchParams.set("owner", "verified");
  const headers = new Headers({
    location: destination.href,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", clearCookie(STATE_COOKIE));
  headers.append("set-cookie", secureCookie(SESSION_COOKIE, session, 3_600));
  return new Response(null, { status: 302, headers });
}

async function ownerAccountId(options: OwnerRequestOptions): Promise<number | null> {
  const sessionCookie = cookies(options.request).get(SESSION_COOKIE);
  if (sessionCookie === undefined) return null;
  try {
    const session = ownerSessionSchema.parse(
      await verifiedToken(
        sessionCookie,
        options.environment.OWNER_SESSION_SECRET,
      ),
    );
    const nowMs = options.nowMs ?? Date.now();
    return session.issuedAtMs <= nowMs && session.expiresAtMs >= nowMs
      ? session.githubAccountId
      : null;
  } catch {
    return null;
  }
}

async function findings(
  options: OwnerRequestOptions,
  requestId: OpaqueId,
): Promise<Response> {
  const accountId = await ownerAccountId(options);
  if (accountId === null) return json({ reason: "OWNER_AUTH_REQUIRED" }, 401);
  const scanRequest = await options.store.getRequest(requestId);
  if (scanRequest === null) return json({ reason: "NOT_FOUND" }, 404);
  if (scanRequest.githubAccountId !== accountId) {
    return json({ reason: "OWNER_MISMATCH" }, 403);
  }
  const cursor = new URL(options.request.url).searchParams.get("cursor");
  if (cursor !== null && !opaqueIdSchema.safeParse(cursor).success) {
    return json({ reason: "NOT_FOUND" }, 404);
  }
  const page = await options.store.listFindings({
    requestId,
    afterFindingId: cursor,
    limit: 100,
  });
  return json(
    operatorFindingPageSchema.parse({
      schemaVersion: 1,
      findings: page.findings,
      ...(page.nextFindingId === null
        ? {}
        : { nextCursor: page.nextFindingId }),
    }),
  );
}

export async function handleOwnerRequest(
  options: OwnerRequestOptions,
): Promise<Response | null> {
  const url = new URL(options.request.url);
  if (options.request.method === "GET" && url.pathname === "/auth/github/start") {
    const requestId = url.searchParams.get("requestId");
    if (requestId === null || !opaqueIdSchema.safeParse(requestId).success) {
      return json({ reason: "NOT_FOUND" }, 404);
    }
    return start(options, requestId);
  }
  if (
    options.request.method === "GET" &&
    url.pathname === "/auth/github/callback"
  ) {
    return callback(options);
  }
  const findingMatch = /^\/api\/owner\/requests\/([A-Za-z0-9_-]{8,64})\/findings$/.exec(
    url.pathname,
  );
  if (options.request.method === "GET" && findingMatch !== null) {
    const requestId = findingMatch[1];
    if (requestId === undefined || !opaqueIdSchema.safeParse(requestId).success) {
      return json({ reason: "NOT_FOUND" }, 404);
    }
    return findings(options, requestId);
  }
  return null;
}
