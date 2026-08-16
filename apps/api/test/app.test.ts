/* eslint-disable @typescript-eslint/require-await -- discovery doubles model asynchronous GitHub */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApi,
  resumePendingDiscoveries,
  type DiscoveryPort,
} from "@app/api";
import {
  operatorFindingPageSchema,
  repositoryPageSchema,
  scanRequestSummarySchema,
} from "@app/contracts";
import { GithubClientError } from "@app/github";
import { SqliteStore } from "@app/store-sqlite";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function store(): Promise<SqliteStore> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-api-"));
  temporaryDirectories.push(root);
  return new SqliteStore({
    filename: path.join(root, "store.sqlite"),
    migrationTimeMs: 1,
  });
}

function discovery(repositoryCount = 2, githubAccountId = 123): DiscoveryPort {
  return {
    async discover() {
      return {
        mode: "authenticated_graphql",
        requestCount: 1,
        account: {
          githubAccountId,
          canonicalLogin: "ri7in",
          repositories: Array.from({ length: repositoryCount }, (_, index) => ({
            repositoryId: index + 1,
            name: `repo-${index + 1}`,
            isFork: index % 2 === 1,
            commitSha: null,
          })),
        },
      };
    },
  };
}

describe("anonymous-safe control-plane API", () => {
  it("replays an interrupted durable discovery after restart", async () => {
    const database = await store();
    await database.createRequest({
      requestId: "req_recovery0001",
      username: "ri7in",
      nowMs: 1,
    });
    expect(await database.startDiscovery("req_recovery0001", 2)).toBe(true);
    let calls = 0;
    const resumed = await resumePendingDiscoveries({
      store: database,
      discovery: {
        async discover() {
          calls += 1;
          return await discovery(1).discover("ri7in");
        },
      },
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      now: () => 3,
    });

    expect(resumed).toBe(1);
    expect(calls).toBe(1);
    expect(await database.getRequest("req_recovery0001")).toMatchObject({
      state: "complete",
      discoveryComplete: true,
      githubAccountId: 123,
    });
    expect(await resumePendingDiscoveries({
      store: database,
      discovery: discovery(1),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      now: () => 4,
    })).toBe(0);
    database.close();
  });

  it("replays every bounded page of pending discoveries", async () => {
    const database = await store();
    for (const [index, username] of ["first-user", "second-user"].entries()) {
      await database.createRequest({
        requestId: `req_paged00000${index + 1}`,
        username,
        nowMs: index + 1,
      });
    }
    const calls: string[] = [];
    const resumed = await resumePendingDiscoveries(
      {
        store: database,
        discovery: {
          async discover(username) {
            calls.push(username);
            const githubAccountId = username === "first-user" ? 101 : 102;
            return {
              mode: "authenticated_graphql",
              requestCount: 1,
              account: {
                githubAccountId,
                canonicalLogin: username,
                repositories: [],
              },
            };
          },
        },
        allowedRequestedLogins: new Set(["first-user", "second-user"]),
        allowedGithubAccountIds: new Set([101, 102]),
        now: () => 10,
      },
      1,
    );

    expect(resumed).toBe(2);
    expect(calls).toEqual(["first-user", "second-user"]);
    for (const requestId of ["req_paged000001", "req_paged000002"]) {
      expect(await database.getRequest(requestId)).toMatchObject({
        state: "complete",
        discoveryComplete: true,
      });
    }
    database.close();
  });

  it("returns one fixed non-echoing response for unexpected failures", async () => {
    const database = await store();
    const app = createApi({
      store: database,
      discovery: discovery(),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      createRequestId: () => "invalid id from operator configuration",
    });
    const response = await app.request("/api/scan-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ri7in" }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ reason: "INTERNAL_ERROR" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    database.close();
  });

  it("records GitHub transport and authentication discovery failures honestly", async () => {
    for (const [code, expected] of [
      ["NETWORK_FAILED", "GITHUB_NETWORK"],
      ["UPSTREAM_FAILED", "GITHUB_NETWORK"],
      ["INVALID_RESPONSE", "GITHUB_NETWORK"],
      ["AUTH_REQUIRED", "GITHUB_AUTH"],
    ] as const) {
      const database = await store();
      const tasks: Array<() => Promise<void>> = [];
      const requestId = `req_${code.toLowerCase()}`;
      const app = createApi({
        store: database,
        discovery: {
          async discover() {
            throw new GithubClientError(code);
          },
        },
        allowedRequestedLogins: new Set(["ri7in"]),
        allowedGithubAccountIds: new Set([123]),
        dispatch: (task) => tasks.push(task),
        createRequestId: () => requestId,
      });
      expect(
        (
          await app.request("/api/scan-requests", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "ri7in" }),
          })
        ).status,
      ).toBe(202);
      await tasks[0]?.();
      expect(await database.getRequest(requestId)).toMatchObject({
        state: "failed",
        reason: expected,
      });
      database.close();
    }
  });

  it("bounds and type-checks the create-request body before JSON parsing", async () => {
    const database = await store();
    const app = createApi({
      store: database,
      discovery: discovery(),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
    });
    for (const request of [
      new Request("http://local/api/scan-requests", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"username":"ri7in"}',
      }),
      new Request("http://local/api/scan-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "ri7in", padding: "x".repeat(2_000) }),
      }),
    ]) {
      const response = await app.request(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ reason: "INVALID_USERNAME" });
    }
    database.close();
  });

  it("persists 202 before discovery, rejects duplicates, and exposes complete coverage", async () => {
    const database = await store();
    const tasks: Array<() => Promise<void>> = [];
    const app = createApi({
      store: database,
      discovery: discovery(101),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      dispatch: (task) => tasks.push(task),
      now: () => 1_000,
      createRequestId: () => "req_0000000001",
    });

    const accepted = await app.request("/api/scan-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ri7in" }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ requestId: "req_0000000001" });
    expect((await database.getRequest("req_0000000001"))?.state).toBe("accepted");

    const duplicate = await app.request("/api/scan-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "RI7IN" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      reason: "DUPLICATE_ACTIVE_REQUEST",
    });

    await tasks[0]?.();
    const summary = await app.request("/api/scan-requests/req_0000000001");
    expect(summary.status).toBe(200);
    const summaryBody = scanRequestSummarySchema.parse(await summary.json());
    expect(summaryBody).toMatchObject({
      requestId: "req_0000000001",
      username: "ri7in",
      state: "complete",
      repositoryTotals: { empty: 101 },
    });
    expect(JSON.stringify(summaryBody)).not.toContain("finding");
    const etag = summary.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const unchanged = await app.request("/api/scan-requests/req_0000000001", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(unchanged.status).toBe(304);

    const firstPage = await app.request(
      "/api/scan-requests/req_0000000001/repositories",
    );
    const firstBody = repositoryPageSchema.parse(await firstPage.json());
    expect(firstBody.repositories).toHaveLength(100);
    expect(firstBody.nextCursor).toMatch(/^repo_/);
    const secondPage = await app.request(
      `/api/scan-requests/req_0000000001/repositories?cursor=${firstBody.nextCursor}`,
    );
    expect(repositoryPageSchema.parse(await secondPage.json()).repositories).toHaveLength(
      1,
    );
    database.close();
  });

  it("refuses non-allowlisted requested logins before creating durable work", async () => {
    const database = await store();
    const app = createApi({
      store: database,
      discovery: discovery(),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
    });
    const response = await app.request("/api/scan-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "someone-else" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ reason: "PRIVATE_SLICE_SCOPE" });
    database.close();
  });

  it("collapses a concurrent duplicate race to one durable request", async () => {
    const database = await store();
    let sequence = 0;
    const tasks: Array<() => Promise<void>> = [];
    const app = createApi({
      store: database,
      discovery: discovery(),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      dispatch: (task) => tasks.push(task),
      createRequestId: () => `req_race00000${sequence += 1}`,
    });
    const responses = await Promise.all(
      ["ri7in", "RI7IN"].map((requestedUsername) =>
        Promise.resolve(
          app.request("/api/scan-requests", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: requestedUsername }),
          }),
        ),
      ),
    );
    expect(responses.map((response) => response.status).toSorted()).toEqual([
      202, 409,
    ]);
    expect(tasks).toHaveLength(1);
    database.close();
  });

  it("fails closed if an allowlisted login resolves to the wrong immutable account", async () => {
    const database = await store();
    const tasks: Array<() => Promise<void>> = [];
    const app = createApi({
      store: database,
      discovery: discovery(1, 999),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      dispatch: (task) => tasks.push(task),
      now: () => 2_000,
      createRequestId: () => "req_0000000002",
    });
    await app.request("/api/scan-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ri7in" }),
    });
    await tasks[0]?.();
    expect(await database.getRequest("req_0000000002")).toMatchObject({
      state: "failed",
      reason: "PRIVATE_SLICE_SCOPE",
      githubAccountId: null,
    });
    database.close();
  });

  it("allows operator findings only on an explicit loopback-bound app", async () => {
    const database = await store();
    for (const bindHost of ["0.0.0.0", "localhost"]) {
      expect(() =>
        createApi({
          store: database,
          discovery: discovery(),
          allowedRequestedLogins: new Set(["ri7in"]),
          allowedGithubAccountIds: new Set([123]),
          operatorMode: true,
          bindHost,
        }),
      ).toThrow("operator mode requires loopback binding");
    }
    const publicApp = createApi({
      store: database,
      discovery: discovery(),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
    });
    expect(
      (await publicApp.request("/api/operator/requests/req_0000000001/findings"))
        .status,
    ).toBe(404);
    const operatorApp = createApi({
      store: database,
      discovery: discovery(),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      operatorMode: true,
      bindHost: "127.0.0.1",
      enforceHostHeader: false,
    });
    expect(
      (await operatorApp.request("/api/operator/requests/req_missing0001/findings", {
        headers: { host: "127.0.0.1" },
      }))
        .status,
    ).toBe(404);
    await database.createRequest({
      requestId: "req_operator001",
      username: "ri7in",
      nowMs: 1,
    });
    const operatorPage = await operatorApp.request(
      "/api/operator/requests/req_operator001/findings",
      { headers: { host: "127.0.0.1" } },
    );
    expect(operatorPage.status).toBe(200);
    expect(operatorFindingPageSchema.parse(await operatorPage.json())).toEqual({
      schemaVersion: 1,
      findings: [],
    });
    expect(
      (
        await operatorApp.request(
          "/api/operator/requests/req_operator001/findings?cursor=bad%20cursor",
          { headers: { host: "127.0.0.1" } },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await operatorApp.request(
          "/api/operator/requests/req_operator001/findings",
          { headers: { host: "attacker.example" } },
        )
      ).status,
    ).toBe(404);
    database.close();
  });

  it("rejects DNS-rebinding host headers in runtime mode", async () => {
    const database = await store();
    const app = createApi({
      store: database,
      discovery: discovery(),
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      operatorMode: true,
      bindHost: "127.0.0.1",
      enforceHostHeader: true,
      dispatch: () => undefined,
    });
    const rebound = await app.request("/api/scan-requests", {
      method: "POST",
      headers: {
        host: "attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "ri7in" }),
    });
    expect(rebound.status).toBe(404);
    expect(await database.findActiveRequestByUsername("ri7in")).toBeNull();

    const local = await app.request("/api/scan-requests", {
      method: "POST",
      headers: {
        host: "127.0.0.1:5173",
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "ri7in" }),
    });
    expect(local.status).toBe(202);
    database.close();
  });
});
