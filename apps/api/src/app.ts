import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  createScanRequestBodySchema,
  opaqueIdSchema,
  operatorFindingPageSchema,
  repositoryPageSchema,
  scanRequestAcceptedSchema,
  scanRequestSummarySchema,
  type GithubLogin,
} from "@app/contracts";
import { aggregateLedger, type Store } from "@app/core";
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
  readonly allowedRequestedLogins: ReadonlySet<string>;
  readonly allowedGithubAccountIds: ReadonlySet<number>;
  readonly dispatch?: (task: () => Promise<void>) => void;
  readonly now?: () => number;
  readonly createRequestId?: () => string;
  readonly operatorMode?: boolean;
  readonly bindHost?: string;
}

function discoveryFailure(error: unknown) {
  if (error instanceof GithubClientError) {
    if (error.code === "RATE_LIMITED") return "GITHUB_RATE_LIMIT" as const;
    if (error.code === "ACCOUNT_NOT_FOUND") return "GITHUB_NOT_FOUND" as const;
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
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function createApi(options: ApiOptions): Hono {
  const now = options.now ?? Date.now;
  const createRequestId =
    options.createRequestId ?? (() => `req_${randomBytes(16).toString("hex")}`);
  const dispatch =
    options.dispatch ??
    ((task: () => Promise<void>) => {
      queueMicrotask(() => {
        void task().catch(() => undefined);
      });
    });
  const operatorMode = options.operatorMode ?? false;
  const bindHost = options.bindHost ?? "127.0.0.1";
  if (operatorMode && !isLoopback(bindHost)) {
    throw new Error("operator mode requires loopback binding");
  }

  const processDiscovery = async (
    requestId: import("@app/contracts").OpaqueId,
    username: GithubLogin,
  ): Promise<void> => {
    if (!(await options.store.startDiscovery(requestId, now()))) return;
    try {
      const result = await options.discovery.discover(username);
      if (!options.allowedGithubAccountIds.has(result.account.githubAccountId)) {
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
    const requestedKey = parsed.data.username.toLowerCase();
    if (
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
      accepted = await options.store.createRequest({
        requestId,
        username: parsed.data.username,
        nowMs: now(),
      });
    } catch (error) {
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
    dispatch(() => processDiscovery(accepted.requestId, parsed.data.username));
    return context.json(scanRequestAcceptedSchema.parse({ requestId }), 202);
  });

  app.get("/api/scan-requests/:requestId", async (context) => {
    const requestId = context.req.param("requestId");
    if (!opaqueIdSchema.safeParse(requestId).success) {
      return context.json({ reason: "NOT_FOUND" }, 404);
    }
    const request = await options.store.getRequest(requestId);
    if (request === null) return context.json({ reason: "NOT_FOUND" }, 404);
    const repositories = [];
    let cursor: number | null = null;
    do {
      const page = await options.store.listRepositories({
        requestId: request.requestId,
        afterRepositoryId: cursor,
        limit: 100,
      });
      repositories.push(...page.repositories);
      cursor = page.nextRepositoryId;
    } while (cursor !== null);
    const aggregate = aggregateLedger(request, repositories);
    const summary = scanRequestSummarySchema.parse({
      schemaVersion: 1,
      requestId: request.requestId,
      username: request.username,
      state: aggregate.requestState,
      ...(request.reason === null ? {} : { reason: request.reason }),
      repositoryTotals: aggregate.repositoryTotals,
      coverageTotals: aggregate.coverageTotals,
      aiLane: request.aiLane,
      retryAfterSeconds: aggregate.requestState === "complete" ? 60 : 2,
      updatedAt: new Date(request.updatedAtMs).toISOString(),
    });
    const etag = `"${createHash("sha256")
      .update(JSON.stringify(summary))
      .digest("hex")}"`;
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
        aiLane: request.aiLane,
      })),
      ...(page.nextRepositoryId === null
        ? {}
        : { nextCursor: encodeCursor(page.nextRepositoryId) }),
    });
    return context.json(response);
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
