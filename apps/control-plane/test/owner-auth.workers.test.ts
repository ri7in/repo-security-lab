/* eslint-disable @typescript-eslint/require-await -- fetch doubles preserve the platform signature */
import { env } from "cloudflare:workers";
import { D1Store } from "@app/store-d1";
import { beforeEach, describe, it } from "vitest";
import { handleOwnerRequest } from "../src/owner-auth.js";

const authEnvironment = {
  GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret-value",
  OWNER_SESSION_SECRET: "owner-session-secret-at-least-thirty-two-characters",
};

async function createCompletedLedger(): Promise<D1Store> {
  const store = new D1Store(env.DB);
  await store.createRequest({
    requestId: "req_ownerproof001",
    username: "owner-user",
    nowMs: 1,
  });
  await store.startDiscovery("req_ownerproof001", 2);
  await store.completeDiscovery({
    requestId: "req_ownerproof001",
    githubAccountId: 900,
    canonicalLogin: "owner-user",
    repositories: [],
    nowMs: 3,
  });
  return store;
}

function cookieValue(header: string, name: string): string {
  const match = new RegExp(`${name}=([^;,]+)`).exec(header);
  if (match?.[1] === undefined) throw new Error(`missing ${name} cookie`);
  return match[1];
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM finding_chunks"),
    env.DB.prepare("DELETE FROM repositories"),
    env.DB.prepare("DELETE FROM request_totals"),
    env.DB.prepare("DELETE FROM scan_requests"),
  ]);
});

describe("owner-only GitHub OAuth", () => {
  it("uses signed state plus PKCE, drops the token, and grants only the matching immutable account", async ({ expect }) => {
    const store = await createCompletedLedger();
    const start = await handleOwnerRequest({
      request: new Request(
        "https://product.test/auth/github/start?requestId=req_ownerproof001",
      ),
      environment: authEnvironment,
      store,
      nowMs: 1_000,
    });
    if (start === null) throw new Error("expected OAuth start response");
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get("location") ?? "");
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toBe("");
    const stateCookie = cookieValue(
      start.headers.get("set-cookie") ?? "",
      "__Host-owner_oauth_state",
    );
    const state = authorization.searchParams.get("state");
    if (state === null) throw new Error("expected OAuth state");
    let tokenCalls = 0;
    let userCalls = 0;
    let revokeCalls = 0;
    const githubFetch: typeof fetch = async (input, init) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      if (url.includes("/login/oauth/access_token")) {
        tokenCalls += 1;
        if (!(init?.body instanceof URLSearchParams)) {
          throw new Error("expected OAuth form body");
        }
        expect(init.body.toString()).toContain("code_verifier=");
        return Response.json({
          access_token: "gho_abcdefghijklmnopqrstuvwxyz123456",
          token_type: "bearer",
          scope: "",
        });
      }
      if (url.includes("/applications/oauth-client-id/token")) {
        revokeCalls += 1;
        expect(init?.method).toBe("DELETE");
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
        expect(init?.body).toBe(
          JSON.stringify({
            access_token: "gho_abcdefghijklmnopqrstuvwxyz123456",
          }),
        );
        return new Response(null, { status: 204 });
      }
      userCalls += 1;
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer gho_abcdefghijklmnopqrstuvwxyz123456",
      );
      return Response.json({ id: 900, login: "owner-user", type: "User" });
    };
    const completed = await handleOwnerRequest({
      request: new Request(
        `https://product.test/auth/github/callback?code=temporary_code&state=${state}`,
        { headers: { cookie: `__Host-owner_oauth_state=${stateCookie}` } },
      ),
      environment: authEnvironment,
      store,
      fetchImpl: githubFetch,
      nowMs: 1_001,
    });
    if (completed === null) throw new Error("expected OAuth callback response");
    expect(completed.status).toBe(302);
    expect(tokenCalls).toBe(1);
    expect(userCalls).toBe(1);
    expect(revokeCalls).toBe(1);
    expect(completed.headers.get("location")).toBe(
      "https://product.test/?request=req_ownerproof001&owner=verified",
    );
    const session = cookieValue(
      completed.headers.get("set-cookie") ?? "",
      "__Host-owner_session",
    );
    const ownerReport = await handleOwnerRequest({
      request: new Request(
        "https://product.test/api/owner/requests/req_ownerproof001/findings",
        { headers: { cookie: `__Host-owner_session=${session}` } },
      ),
      environment: authEnvironment,
      store,
      nowMs: 1_002,
    });
    expect(ownerReport?.status).toBe(200);
    expect(await ownerReport?.json()).toEqual({ schemaVersion: 1, findings: [] });
  });

  it("fails closed on missing sessions and identity mismatch", async ({ expect }) => {
    const store = await createCompletedLedger();
    const unauthorized = await handleOwnerRequest({
      request: new Request(
        "https://product.test/api/owner/requests/req_ownerproof001/findings",
      ),
      environment: authEnvironment,
      store,
      nowMs: 1_000,
    });
    expect(unauthorized?.status).toBe(401);

    const start = await handleOwnerRequest({
      request: new Request(
        "https://product.test/auth/github/start?requestId=req_ownerproof001",
      ),
      environment: authEnvironment,
      store,
      nowMs: 1_000,
    });
    if (start === null) throw new Error("expected OAuth start response");
    const authorization = new URL(start.headers.get("location") ?? "");
    const state = authorization.searchParams.get("state");
    const stateCookie = cookieValue(
      start.headers.get("set-cookie") ?? "",
      "__Host-owner_oauth_state",
    );
    const mismatch = await handleOwnerRequest({
      request: new Request(
        `https://product.test/auth/github/callback?code=temporary_code&state=${state ?? ""}`,
        { headers: { cookie: `__Host-owner_oauth_state=${stateCookie}` } },
      ),
      environment: authEnvironment,
      store,
      fetchImpl: async (input) => {
        const url = input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
        if (url.includes("access_token")) {
          return Response.json({
            access_token: "gho_abcdefghijklmnopqrstuvwxyz123456",
            token_type: "bearer",
            scope: "",
          });
        }
        if (url.includes("/applications/")) {
          return new Response(null, { status: 204 });
        }
        return Response.json({ id: 901, login: "attacker", type: "User" });
      },
      nowMs: 1_001,
    });
    expect(mismatch?.status).toBe(403);
  });

  it("fails closed when the short-lived identity token cannot be revoked", async ({ expect }) => {
    const store = await createCompletedLedger();
    const start = await handleOwnerRequest({
      request: new Request(
        "https://product.test/auth/github/start?requestId=req_ownerproof001",
      ),
      environment: authEnvironment,
      store,
      nowMs: 1_000,
    });
    if (start === null) throw new Error("expected OAuth start response");
    const authorization = new URL(start.headers.get("location") ?? "");
    const state = authorization.searchParams.get("state") ?? "";
    const stateCookie = cookieValue(
      start.headers.get("set-cookie") ?? "",
      "__Host-owner_oauth_state",
    );
    const result = await handleOwnerRequest({
      request: new Request(
        `https://product.test/auth/github/callback?code=temporary_code&state=${state}`,
        { headers: { cookie: `__Host-owner_oauth_state=${stateCookie}` } },
      ),
      environment: authEnvironment,
      store,
      fetchImpl: async (input) => {
        const url = input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
        if (url.includes("access_token")) {
          return Response.json({
            access_token: "gho_abcdefghijklmnopqrstuvwxyz123456",
            token_type: "bearer",
            scope: "",
          });
        }
        if (url.includes("/applications/")) {
          return Response.json({ message: "failed" }, { status: 500 });
        }
        return Response.json({ id: 900, login: "owner-user", type: "User" });
      },
      nowMs: 1_001,
    });
    expect(result?.status).toBe(502);
    expect(result?.headers.get("set-cookie")).toBeNull();
  });
});
