import { Hono } from "hono";
import {
  createScanRequestBodySchema,
  opaqueIdSchema,
  operatorFindingPageSchema,
  publicCapabilitiesSchema,
  type AiLaneState,
  type DeepReadBudget,
  publicFindingPageSchema,
  repositoryPageSchema,
  scanRequestAcceptedSchema,
  scanRequestSummarySchema,
  type GithubLogin,
  type OpaqueId,
} from "@app/contracts";
import { StoreWriteReserveError, type Store } from "@app/core";
import { councilBudget, toDeepReadBudget } from "@app/quota";
import {
  GithubClientError,
  type DiscoveryResult,
} from "@app/github";

const MAX_CREATE_BODY_BYTES = 1_024;
const jsonDecoder = new TextDecoder("utf-8", { fatal: true });

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  const contentEncoding = request.headers.get("content-encoding");
  const declaredLength = request.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (contentEncoding !== null && contentEncoding !== "identity") ||
    (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MAX_CREATE_BODY_BYTES)) ||
    request.body === null
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
      if (total > MAX_CREATE_BODY_BYTES) {
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
  return JSON.parse(jsonDecoder.decode(bytes)) as unknown;
}

export interface DiscoveryPort {
  discover(username: string): Promise<DiscoveryResult>;
}

export interface ApiOptions {
  readonly store: Store;
  readonly discovery: DiscoveryPort;
  /** Null is the public service; a set retains the private-slice safety gate. */
  readonly allowedRequestedLogins: ReadonlySet<string> | null;
  readonly allowedGithubAccountIds: ReadonlySet<number> | null;
  readonly dispatch?: (task: () => Promise<void>) => void;
  readonly now?: () => number;
  readonly createRequestId?: () => string;
  readonly admitScanRequest?: (
    username: GithubLogin,
    request: Request,
  ) => Promise<boolean>;
  readonly registerNotification?: (input: {
    readonly requestId: OpaqueId;
    readonly email: string;
    readonly nowMs: number;
  }) => Promise<"queued" | "rate_limited" | "unavailable">;
  readonly publicCapabilities?: {
    readonly scanCreation: "private_preview" | "public";
    readonly emailNotifications: boolean;
  };
  /**
   * Remaining council allowance. Omitted callers get the untouched-day budget,
   * which is what a deployment without recorded spend honestly has.
   */
  readonly deepReadBudget?: () => DeepReadBudget | Promise<DeepReadBudget>;
  readonly operatorMode?: boolean;
  readonly bindHost?: string;
  readonly enforceHostHeader?: boolean;
}

export interface DiscoveryProcessingOptions {
  readonly store: Store;
  readonly discovery: DiscoveryPort;
  readonly allowedRequestedLogins: ReadonlySet<string> | null;
  readonly allowedGithubAccountIds: ReadonlySet<number> | null;
  readonly now?: () => number;
}

function randomRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const value = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `req_${value}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function discoveryFailure(error: unknown) {
  if (error instanceof StoreWriteReserveError) {
    return "D1_WRITE_RESERVE" as const;
  }
  if (error instanceof GithubClientError) {
    if (error.code === "RATE_LIMITED") return "GITHUB_RATE_LIMIT" as const;
    if (error.code === "ACCOUNT_NOT_FOUND") return "GITHUB_NOT_FOUND" as const;
    if (error.code === "AUTH_REQUIRED") return "GITHUB_AUTH" as const;
    if (
      error.code === "NETWORK_FAILED" ||
      error.code === "UPSTREAM_FAILED" ||
      error.code === "INVALID_RESPONSE"
    ) {
      return "GITHUB_NETWORK" as const;
    }
    if (error.code === "REPOSITORY_CHANGED") return "REPOSITORY_CHANGED" as const;
  }
  return "REPOSITORY_CHANGED" as const;
}

function encodeCursor(repositoryId: number): string {
  return `repo_${repositoryId.toString(36).padStart(8, "0")}`;
}

function decodeCursor(value: string | undefined): number | null | undefined {
  if (value === undefined) return null;
  if (!/^repo_[0-9a-z]{8,16}$/.test(value)) return undefined;
  const parsed = Number.parseInt(value.slice(5), 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function matchesBindHost(hostHeader: string | undefined, bindHost: string): boolean {
  if (hostHeader === undefined) return false;
  const pattern =
    bindHost === "::1"
      ? /^\[::1\](?::(\d{1,5}))?$/
      : /^127\.0\.0\.1(?::(\d{1,5}))?$/;
  const match = pattern.exec(hostHeader);
  if (match === null) return false;
  const port = match[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

async function processDiscovery(
  options: DiscoveryProcessingOptions,
  requestId: OpaqueId,
  username: GithubLogin,
): Promise<void> {
  const now = options.now ?? Date.now;
  if (!(await options.store.startDiscovery(requestId, now()))) return;
  const requestedKey = username.toLowerCase();
  if (
    options.allowedRequestedLogins !== null &&
    ![...options.allowedRequestedLogins].some(
      (login) => login.toLowerCase() === requestedKey,
    )
  ) {
    await options.store.failRequest({
      requestId,
      reason: "PRIVATE_SLICE_SCOPE",
      nowMs: now(),
    });
    return;
  }
  try {
    const result = await options.discovery.discover(username);
    if (
      options.allowedGithubAccountIds !== null &&
      !options.allowedGithubAccountIds.has(result.account.githubAccountId)
    ) {
      await options.store.failRequest({
        requestId,
        reason: "PRIVATE_SLICE_SCOPE",
        nowMs: now(),
      });
      return;
    }
    const completion = await options.store.completeDiscovery({
      requestId,
      githubAccountId: result.account.githubAccountId,
      canonicalLogin: result.account.canonicalLogin,
      repositories: result.account.repositories,
      nowMs: now(),
    });
    if (completion !== "completed" && completion !== "idempotent") {
      await options.store.failRequest({
        requestId,
        reason: "REPOSITORY_CHANGED",
        nowMs: now(),
      });
    }
  } catch (error) {
    await options.store.failRequest({
      requestId,
      reason: discoveryFailure(error),
      nowMs: now(),
    });
  }
}

/** Replays durable accepted/discovering rows after a local-runtime restart. */
export async function resumePendingDiscoveries(
  options: DiscoveryProcessingOptions,
  pageSize = 100,
  maximumRequests = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    (!Number.isSafeInteger(maximumRequests) && maximumRequests !== Number.POSITIVE_INFINITY) ||
    maximumRequests < 1
  ) {
    throw new Error("invalid discovery recovery bound");
  }
  const attempted = new Set<OpaqueId>();
  while (attempted.size < maximumRequests) {
    const remaining = maximumRequests - attempted.size;
    const pending = await options.store.listPendingDiscoveryRequests(
      Math.min(pageSize, remaining),
    );
    if (pending.length === 0) return attempted.size;
    for (const request of pending) {
      if (attempted.has(request.requestId)) {
        // Do not start while an accepted/discovering row cannot make durable
        // progress; otherwise it could also starve later pages forever.
        throw new Error("pending discovery recovery stalled");
      }
      attempted.add(request.requestId);
      await processDiscovery(options, request.requestId, request.username);
    }
  }
  return attempted.size;
}

/**
 * Resolves the council budget for the capabilities response. A deployment with
 * no spend recorder reports the untouched-day budget rather than claiming zero,
 * because zero would wrongly tell visitors the lane is exhausted.
 */
async function resolveDeepReadBudget(options: {
  readonly deepReadBudget?: () => DeepReadBudget | Promise<DeepReadBudget>;
}): Promise<DeepReadBudget> {
  if (options.deepReadBudget === undefined) return toDeepReadBudget(councilBudget());
  return options.deepReadBudget();
}

/**
 * The AI review lane for one repository, read from its own coverage.
 *
 * This used to report the request-level lane, which never leaves
 * `ai_not_run`, so a repository a model had genuinely read still told every
 * caller the review had not happened. Coverage is the durable per-repository
 * record and is what the worker actually writes.
 *
 * The lane vocabulary is narrower than coverage: it has no word for "the
 * provider could not be reached", so a failed review reports as not run here
 * and the precise outcome stays in `coverage.ai`, which this same response
 * carries.
 */
function repositoryAiLane(coverage: string): AiLaneState {
  if (coverage === "complete") return "ai_complete";
  if (coverage === "partial") return "ai_partial";
  if (coverage === "waiting") return "ai_waiting";
  return "ai_not_run";
}

export function createApi(options: ApiOptions): Hono {
  const now = options.now ?? Date.now;
  const createRequestId =
    options.createRequestId ?? randomRequestId;
  const dispatch =
    options.dispatch ??
    ((task: () => Promise<void>) => {
      queueMicrotask(() => {
        void task().catch(() => undefined);
      });
    });
  const operatorMode = options.operatorMode ?? false;
  const bindHost = options.bindHost ?? "127.0.0.1";
  // Operator detail is sensitive even though it is source-blind. Make the
  // DNS-rebinding guard an invariant of operator mode rather than a caller
  // option that another runtime composition could accidentally omit.
  const enforceHostHeader = operatorMode || (options.enforceHostHeader ?? false);
  if (operatorMode && !isLoopback(bindHost)) {
    throw new Error("operator mode requires loopback binding");
  }

  const discoveryOptions: DiscoveryProcessingOptions = {
    store: options.store,
    discovery: options.discovery,
    allowedRequestedLogins: options.allowedRequestedLogins,
    allowedGithubAccountIds: options.allowedGithubAccountIds,
    now,
  };

  const app = new Hono();
  app.onError((_error, context) =>
    context.json({ reason: "INTERNAL_ERROR" }, 500),
  );
  app.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
  });
  if (enforceHostHeader) {
    app.use("*", async (context, next) => {
      if (!matchesBindHost(context.req.header("host"), bindHost)) {
        return context.json({ reason: "NOT_FOUND" }, 404);
      }
      await next();
    });
  }

  app.get("/api/capabilities", async (context) =>
    context.json(
      publicCapabilitiesSchema.parse(
        {
          schemaVersion: 1,
          deepRead: await resolveDeepReadBudget(options),
          ...(options.publicCapabilities ?? {
            scanCreation:
              options.allowedRequestedLogins === null
                ? "public"
                : "private_preview",
            emailNotifications: options.registerNotification !== undefined,
          }),
        },
      ),
    ),
  );

  app.post("/api/scan-requests", async (context) => {
    let body: unknown;
    try {
      body = await readBoundedJson(context.req.raw);
    } catch {
      return context.json({ reason: "INVALID_USERNAME" as const }, 400);
    }
    const parsed = createScanRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ reason: "INVALID_USERNAME" as const }, 400);
    }
    if (
      parsed.data.email !== undefined &&
      options.registerNotification === undefined
    ) {
      return context.json({ reason: "EMAIL_UNAVAILABLE" as const }, 503);
    }
    if (
      options.admitScanRequest !== undefined &&
      !(await options.admitScanRequest(parsed.data.username, context.req.raw))
    ) {
      return context.json({ reason: "RATE_LIMITED" as const }, 429);
    }
    const requestedKey = parsed.data.username.toLowerCase();
    if (
      options.allowedRequestedLogins !== null &&
      ![...options.allowedRequestedLogins].some(
        (login) => login.toLowerCase() === requestedKey,
      )
    ) {
      return context.json({ reason: "PRIVATE_SLICE_SCOPE" as const }, 403);
    }
    const duplicate = await options.store.findActiveRequestByUsername(
      parsed.data.username,
    );
    if (duplicate !== null) {
      return context.json({ reason: "DUPLICATE_ACTIVE_REQUEST" as const }, 409);
    }
    const requestId = createRequestId();
    if (!opaqueIdSchema.safeParse(requestId).success) {
      throw new Error("request id factory returned invalid id");
    }
    let accepted;
    try {
      // Cloudflare resolves the country at the edge and sends it as a header,
      // so the application never handles an address. Absent everywhere else,
      // including local runs, which is why it is optional rather than required.
      const country = context.req.header("cf-ipcountry");
      accepted = await options.store.createRequest({
        requestId,
        username: parsed.data.username,
        nowMs: now(),
        ...(country === undefined ? {} : { country }),
      });
    } catch (error) {
      if (error instanceof StoreWriteReserveError) {
        context.header("Retry-After", "3600");
        return context.json({ reason: "CAPACITY_EXHAUSTED" as const }, 503);
      }
      const concurrent = await options.store.findActiveRequestByUsername(
        parsed.data.username,
      );
      if (concurrent !== null) {
        return context.json(
          { reason: "DUPLICATE_ACTIVE_REQUEST" as const },
          409,
        );
      }
      throw error;
    }
    dispatch(() =>
      processDiscovery(
        discoveryOptions,
        accepted.requestId,
        parsed.data.username,
      ),
    );
    let notification:
      | "not_requested"
      | "queued"
      | "rate_limited"
      | "unavailable" = "not_requested";
    if (parsed.data.email !== undefined && options.registerNotification !== undefined) {
      try {
        notification = await options.registerNotification({
          requestId: accepted.requestId,
          email: parsed.data.email,
          nowMs: now(),
        });
      } catch {
        notification = "unavailable";
      }
    }
    return context.json(
      scanRequestAcceptedSchema.parse({ requestId, notification }),
      202,
    );
  });

  app.get("/api/scan-requests/:requestId", async (context) => {
    const requestId = context.req.param("requestId");
    if (!opaqueIdSchema.safeParse(requestId).success) {
      return context.json({ reason: "NOT_FOUND" }, 404);
    }
    const request = await options.store.getRequest(requestId);
    if (request === null) return context.json({ reason: "NOT_FOUND" }, 404);
    const totals = await options.store.getRequestTotals(request.requestId);
    if (totals === null) return context.json({ reason: "NOT_FOUND" }, 404);
    const summary = scanRequestSummarySchema.parse({
      schemaVersion: 1,
      requestId: request.requestId,
      username: request.username,
      state: request.state,
      ...(request.reason === null ? {} : { reason: request.reason }),
      repositoryTotals: totals.repositoryTotals,
      coverageTotals: totals.coverageTotals,
      aiLane: request.aiLane,
      retryAfterSeconds: request.state === "complete" ? 60 : 3,
      updatedAt: new Date(request.updatedAtMs).toISOString(),
    });
    const etag = `"${await sha256Hex(JSON.stringify(summary))}"`;
    context.header("ETag", etag);
    if (context.req.header("If-None-Match") === etag) {
      return context.body(null, 304);
    }
    return context.json(summary);
  });

  app.get("/api/scan-requests/:requestId/repositories", async (context) => {
    const requestId = context.req.param("requestId");
    const cursor = decodeCursor(context.req.query("cursor"));
    if (!opaqueIdSchema.safeParse(requestId).success || cursor === undefined) {
      return context.json({ reason: "NOT_FOUND" }, 404);
    }
    const request = await options.store.getRequest(requestId);
    if (request === null) return context.json({ reason: "NOT_FOUND" }, 404);
    const page = await options.store.listRepositories({
      requestId: request.requestId,
      afterRepositoryId: cursor,
      limit: 100,
    });
    const response = repositoryPageSchema.parse({
      schemaVersion: 1,
      requestId: request.requestId,
      repositories: page.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        name: repository.name,
        state: repository.state,
        ...(repository.reason === null ? {} : { reason: repository.reason }),
        coverage: repository.coverage,
        ...(Object.keys(repository.specialistReasons).length === 0
          ? {}
          : { specialistReasons: repository.specialistReasons }),
        aiLane: repositoryAiLane(repository.coverage.ai),
      })),
      ...(page.nextRepositoryId === null
        ? {}
        : { nextCursor: encodeCursor(page.nextRepositoryId) }),
    });
    return context.json(response);
  });

  app.get("/api/scan-requests/:requestId/findings", async (context) => {
    const requestId = context.req.param("requestId");
    const afterFindingId = context.req.query("cursor") ?? null;
    if (
      !opaqueIdSchema.safeParse(requestId).success ||
      (afterFindingId !== null &&
        !opaqueIdSchema.safeParse(afterFindingId).success)
    ) {
      return context.json({ reason: "NOT_FOUND" }, 404);
    }
    if ((await options.store.getRequest(requestId)) === null) {
      return context.json({ reason: "NOT_FOUND" }, 404);
    }
    const page = await options.store.listFindings({
      requestId,
      afterFindingId,
      limit: 100,
    });
    context.header("Cache-Control", "no-store");
    return context.json(
      publicFindingPageSchema.parse({
        schemaVersion: 1,
        findings: page.findings.map((finding) => ({
          schema_version: finding.schema_version,
          repository_id: finding.repository_id,
          commit_sha: finding.commit_sha,
          engine: finding.engine,
          rule_id: finding.rule_id,
          category: finding.category,
          severity: finding.severity,
          confidence: finding.confidence,
          occurrence_bucket: finding.occurrence_bucket,
          remediation_key: finding.remediation_key,
          ...(finding.locations === undefined
            ? {}
            : { locations: finding.locations }),
        })),
        ...(page.nextFindingId === null
          ? {}
          : { nextCursor: page.nextFindingId }),
      }),
    );
  });

  if (operatorMode) {
    app.get("/api/operator/requests/:requestId/findings", async (context) => {
      const requestId = context.req.param("requestId");
      const afterFindingId = context.req.query("cursor") ?? null;
      if (
        !opaqueIdSchema.safeParse(requestId).success ||
        (afterFindingId !== null &&
          !opaqueIdSchema.safeParse(afterFindingId).success)
      ) {
        return context.json({ reason: "NOT_FOUND" }, 404);
      }
      if ((await options.store.getRequest(requestId)) === null) {
        return context.json({ reason: "NOT_FOUND" }, 404);
      }
      const page = await options.store.listFindings({
        requestId,
        afterFindingId,
        limit: 100,
      });
      return context.json(
        operatorFindingPageSchema.parse({
          schemaVersion: 1,
          findings: page.findings,
          ...(page.nextFindingId === null
            ? {}
            : { nextCursor: page.nextFindingId }),
        }),
      );
    });
  }

  app.notFound((context) => context.json({ reason: "NOT_FOUND" }, 404));
  return app;
}
