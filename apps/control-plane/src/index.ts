import { createApi, resumePendingDiscoveries } from "@app/api";
import type { GithubLogin } from "@app/contracts";
import { GithubDiscoveryClient } from "@app/github";
import { D1Store, type D1Database } from "@app/store-d1";
import { handleInternalRequest } from "./internal-api.js";
import {
  deliverOneNotification,
  notificationConfiguration,
  registerNotification,
  type NotificationEnvironment,
} from "./notifications.js";
import { purgeExpiredReports } from "./retention.js";

interface ExecutionContextPort {
  waitUntil(promise: Promise<unknown>): void;
}

interface RateLimitPort {
  limit(input: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

interface AssetPort {
  fetch(request: Request): Promise<Response>;
}

export interface ControlPlaneEnvironment extends NotificationEnvironment {
  readonly DB: D1Database;
  readonly ASSETS: AssetPort;
  readonly REQUESTER_RATE_LIMITER: RateLimitPort;
  readonly READ_RATE_LIMITER: RateLimitPort;
  readonly USERNAME_RATE_LIMITER: RateLimitPort;
  readonly INTERNAL_RATE_LIMITER: RateLimitPort;
  readonly PUBLIC_SCANNING_ENABLED: string;
  readonly PRIVATE_SLICE_LOGINS: string;
  readonly PRIVATE_SLICE_ACCOUNT_IDS: string;
  readonly GITHUB_TOKEN?: string;
  readonly WORKER_AUTH_MASTER_SECRET?: string | undefined;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function scope(environment: ControlPlaneEnvironment): {
  readonly requestedLogins: ReadonlySet<string> | null;
  readonly accountIds: ReadonlySet<number> | null;
} {
  if (environment.PUBLIC_SCANNING_ENABLED === "true") {
    return { requestedLogins: null, accountIds: null };
  }
  const accountIds = csv(environment.PRIVATE_SLICE_ACCOUNT_IDS).map(Number);
  if (
    accountIds.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    new Set(accountIds).size !== accountIds.length
  ) {
    throw new Error("invalid private account scope");
  }
  const logins = csv(environment.PRIVATE_SLICE_LOGINS).map((value) =>
    value.toLowerCase(),
  );
  return {
    requestedLogins: new Set(logins),
    accountIds: new Set(accountIds),
  };
}

function discovery(environment: ControlPlaneEnvironment): GithubDiscoveryClient {
  return new GithubDiscoveryClient({
    ...(environment.GITHUB_TOKEN === undefined || environment.GITHUB_TOKEN === ""
      ? {}
      : { token: environment.GITHUB_TOKEN }),
  });
}

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function admitScanRequest(
  environment: ControlPlaneEnvironment,
  username: GithubLogin,
  request: Request,
): Promise<boolean> {
  const requester = request.headers.get("cf-connecting-ip") ?? "unknown";
  const [requesterResult, usernameResult] = await Promise.all([
    environment.REQUESTER_RATE_LIMITER.limit({ key: `requester:${requester}` }),
    environment.USERNAME_RATE_LIMITER.limit({
      key: `username:${username.toLowerCase()}`,
    }),
  ]);
  return requesterResult.success && usernameResult.success;
}

export async function handleControlPlaneRequest(
  request: Request,
  environment: ControlPlaneEnvironment,
  context: ExecutionContextPort,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/internal/")) {
    const requester = request.headers.get("cf-connecting-ip") ?? "unknown";
    const admitted = await environment.INTERNAL_RATE_LIMITER.limit({
      key: `internal:${requester}`,
    });
    if (!admitted.success) {
      return secured(Response.json(
        { reason: "RATE_LIMITED" },
        { status: 429, headers: { "cache-control": "no-store" } },
      ));
    }
    return secured(await handleInternalRequest(request, {
      DB: environment.DB,
      WORKER_AUTH_MASTER_SECRET:
        environment.WORKER_AUTH_MASTER_SECRET ?? "",
    }));
  }
  if (
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/api/owner/")
  ) {
    return secured(
      Response.json(
        { reason: "NOT_FOUND" },
        { status: 404, headers: { "cache-control": "no-store" } },
      ),
    );
  }
  if (url.pathname.startsWith("/api/")) {
    if (request.method === "GET" && url.pathname !== "/api/capabilities") {
      const requester = request.headers.get("cf-connecting-ip") ?? "unknown";
      const admitted = await environment.READ_RATE_LIMITER.limit({
        key: `read:${requester}`,
      });
      if (!admitted.success) {
        return secured(
          Response.json(
            { reason: "RATE_LIMITED" },
            { status: 429, headers: { "cache-control": "no-store" } },
          ),
        );
      }
    }
    const configuredScope = scope(environment);
    const configuredNotifications = notificationConfiguration(environment);
    const app = createApi({
      store: new D1Store(environment.DB),
      discovery: discovery(environment),
      allowedRequestedLogins: configuredScope.requestedLogins,
      allowedGithubAccountIds: configuredScope.accountIds,
      dispatch: (task) => context.waitUntil(task()),
      admitScanRequest: (username, rawRequest) =>
        admitScanRequest(environment, username, rawRequest),
      ...(configuredNotifications === null
        ? {}
        : {
            registerNotification: (input) =>
              registerNotification(environment.DB, configuredNotifications, input),
          }),
      publicCapabilities: {
        scanCreation:
          configuredScope.requestedLogins === null ? "public" : "private_preview",
        emailNotifications: configuredNotifications !== null,
        scanEtaMinutes: { min: 2, max: 5 },
      },
    });
    return secured(await app.fetch(request));
  }
  return secured(await environment.ASSETS.fetch(request));
}

async function recoverPendingDiscoveries(
  environment: ControlPlaneEnvironment,
): Promise<void> {
  const configuredScope = scope(environment);
  await resumePendingDiscoveries(
    {
      store: new D1Store(environment.DB),
      discovery: discovery(environment),
      allowedRequestedLogins: configuredScope.requestedLogins,
      allowedGithubAccountIds: configuredScope.accountIds,
    },
    25,
  );
}

async function runScheduledMaintenance(
  environment: ControlPlaneEnvironment,
): Promise<void> {
  const configuration = notificationConfiguration(environment);
  const tasks: Promise<unknown>[] = [
    recoverPendingDiscoveries(environment),
    purgeExpiredReports(environment.DB),
  ];
  if (configuration !== null) {
    tasks.push(deliverOneNotification(environment.DB, configuration));
  }
  const results = await Promise.allSettled(tasks);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("scheduled maintenance failed");
  }
}

export default {
  fetch(
    request: Request,
    environment: ControlPlaneEnvironment,
    context: ExecutionContextPort,
  ): Promise<Response> {
    return handleControlPlaneRequest(request, environment, context);
  },
  scheduled(
    _event: unknown,
    environment: ControlPlaneEnvironment,
    context: ExecutionContextPort,
  ): void {
    context.waitUntil(runScheduledMaintenance(environment));
  },
};
