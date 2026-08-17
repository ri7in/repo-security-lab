import { env } from "cloudflare:workers";
import { describe, it } from "vitest";
import {
  handleControlPlaneRequest,
  type ControlPlaneEnvironment,
} from "../src/index.js";

function environment(
  overrides: Partial<ControlPlaneEnvironment> = {},
): ControlPlaneEnvironment {
  return {
    DB: env.DB,
    ASSETS: {
      fetch: () =>
        Promise.resolve(
          new Response("asset", { headers: { "content-type": "text/plain" } }),
        ),
    },
    REQUESTER_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: true }),
    },
    READ_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: true }),
    },
    USERNAME_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: true }),
    },
    INTERNAL_RATE_LIMITER: {
      limit: () => Promise.resolve({ success: true }),
    },
    PUBLIC_SCANNING_ENABLED: "false",
    PRIVATE_SLICE_LOGINS: "ri7in",
    PRIVATE_SLICE_ACCOUNT_IDS: "123",
    WORKER_AUTH_MASTER_SECRET: "worker-master-secret-at-least-thirty-two-chars",
    ...overrides,
  };
}

const context = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise;
  },
};

describe("control-plane boundary", () => {
  it("adds browser security headers to static assets", async ({ expect }) => {
    const response = await handleControlPlaneRequest(
      new Request("https://product.test/"),
      environment(),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("strict-transport-security")).toContain(
      "max-age=31536000",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps third-party account admission disabled by default", async ({ expect }) => {
    const response = await handleControlPlaneRequest(
      new Request("https://product.test/api/scan-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "octocat" }),
      }),
      environment(),
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ reason: "PRIVATE_SLICE_SCOPE" });
  });

  it("does not expose legacy login routes", async ({ expect }) => {
    for (const path of [
      "/auth/github/start?requestId=request_0001",
      "/api/owner/requests/request_0001/findings",
    ]) {
      const response = await handleControlPlaneRequest(
        new Request(`https://product.test${path}`),
        environment(),
        context,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ reason: "NOT_FOUND" });
    }
  });

  it("rate-limits the public worker edge before authentication reads", async ({ expect }) => {
    const response = await handleControlPlaneRequest(
      new Request("https://product.test/internal/v1/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseDurationMs: 600_000 }),
      }),
      environment({
        INTERNAL_RATE_LIMITER: {
          limit: () => Promise.resolve({ success: false }),
        },
      }),
      context,
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ reason: "RATE_LIMITED" });
  });

  it("rate-limits public report reads without affecting capabilities", async ({ expect }) => {
    const blocked = environment({
      READ_RATE_LIMITER: {
        limit: () => Promise.resolve({ success: false }),
      },
    });
    const report = await handleControlPlaneRequest(
      new Request("https://product.test/api/scan-requests/req_missing0001"),
      blocked,
      context,
    );
    expect(report.status).toBe(429);
    expect(await report.json()).toEqual({ reason: "RATE_LIMITED" });

    const capabilities = await handleControlPlaneRequest(
      new Request("https://product.test/api/capabilities"),
      blocked,
      context,
    );
    expect(capabilities.status).toBe(200);
  });
});
