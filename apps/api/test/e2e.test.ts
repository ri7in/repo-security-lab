import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { createApi } from "@app/api";
import { SourceBlindBroker } from "@app/broker";
import { scanRequestSummarySchema } from "@app/contracts";
import {
  GITLEAKS_BROKER_MANIFEST,
  GitleaksScanner,
  ScannerError,
} from "@app/scanners";
import { SqliteStore } from "@app/store-sqlite";
import { RepositoryWorker } from "@app/worker";

const enabled = process.env["RUN_GITLEAKS_E2E"] === "1";
const binaryPath = process.env["GITLEAKS_BINARY"];
const binaryHash = process.env["GITLEAKS_SHA256"];
const temporaryDirectories: string[] = [];
const COMMIT_SHA = "a".repeat(40);
const SOURCE_CANARY = "RVN_8a6d2f91c4b7e503";
/**
 * Canary planted in the FILE NAME rather than the file contents.
 *
 * Reports now publish the path and line of each finding, so unlike the two
 * canaries above this one is EXPECTED to cross egress, and the test asserts
 * that it does. It is the proof that locations survive the whole pipeline
 * rather than being silently dropped.
 *
 * The split matters: paths are published on purpose, file contents and secret
 * values are still forbidden everywhere. Keeping both assertions in one test
 * is what stops "we publish locations" quietly widening into "we publish
 * whatever the scanner saw".
 */
const PATH_CANARY = "RVN_PATH_3d9e7b41f2a6c805";
const SYNTHETIC_SECRET = [
  "ghp",
  "_",
  "X7mQ2vN9cR4tK8pL3sW6yB1dF5hJ0aZ2uE9",
].join("");

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

afterEach(() => vi.restoreAllMocks());

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(0o600, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(data.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    header,
    148,
  );
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

function fixtureArchive(): Uint8Array {
  const content = Buffer.from(`${SOURCE_CANARY}\nTOKEN=${SYNTHETIC_SECRET}\n`);
  return gzipSync(
    Buffer.concat([
      tarEntry(`fixture-repo/${PATH_CANARY}-credential.txt`, content),
      Buffer.alloc(1_024),
    ]),
  );
}

function eightCharacterWindows(value: string): string[] {
  return Array.from(
    { length: Math.max(0, value.length - 7) },
    (_, index) => value.slice(index, index + 8),
  );
}

test.skipIf(!enabled || binaryPath === undefined || binaryHash === undefined)(
  "runs the complete private slice and proves the tested canaries never cross egress",
  async () => {
    if (binaryPath === undefined || binaryHash === undefined) {
      throw new Error("verified Gitleaks fixture is unavailable");
    }
    const root = await mkdtemp(path.join(tmpdir(), "repo-security-e2e-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "store.sqlite");
    const scratchPath = path.join(root, "scratch");
    const store = new SqliteStore({ filename: databasePath, migrationTimeMs: 1 });
    const tasks: Array<() => Promise<void>> = [];
    const capturedResponses: string[] = [];
    const capturedLogs: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        capturedLogs.push(
          values
            .map((value) =>
              typeof value === "string" ? value : JSON.stringify(value),
            )
            .join(" "),
        );
      });
    }
    const app = createApi({
      store,
      discovery: {
        discover: () =>
          Promise.resolve({
            mode: "authenticated_graphql" as const,
            requestCount: 1,
            account: {
              githubAccountId: 123,
              canonicalLogin: "ri7in" as const,
              repositories: [
                {
                  repositoryId: 7,
                  name: "fixture-repo" as const,
                  isFork: false,
                  commitSha: COMMIT_SHA,
                },
              ],
            },
          }),
      },
      allowedRequestedLogins: new Set(["ri7in"]),
      allowedGithubAccountIds: new Set([123]),
      dispatch: (task) => tasks.push(task),
      createRequestId: () => "req_e2e00000001",
      now: () => 1_000,
      operatorMode: true,
      bindHost: "127.0.0.1",
    });

    const accepted = await app.request("/api/scan-requests", {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: "ri7in" }),
    });
    capturedResponses.push(await accepted.text());
    expect(accepted.status).toBe(202);
    await tasks[0]?.();

    const archiveBytes = fixtureArchive();
    const scanner = new GitleaksScanner({
      binaryPath,
      expectedBinarySha256: binaryHash,
    });
    const worker = new RepositoryWorker({
      store,
      archiveFetcher: {
        fetchArchive: () => {
          const body = new Response(Uint8Array.from(archiveBytes).buffer).body;
          if (body === null) throw new Error("fixture body missing");
          return Promise.resolve({
            body,
            contentLength: archiveBytes.byteLength,
            requestCount: 1 as const,
          });
        },
      },
      gitleaks: {
        async scan(sourceDirectory) {
          try {
            return await scanner.scan(sourceDirectory);
          } catch (error) {
            capturedLogs.push(
              JSON.stringify({
                event: "scanner_error",
                code:
                  error instanceof ScannerError ? error.code : "UNKNOWN_ERROR",
              }),
            );
            throw error;
          }
        },
      },
      gitleaksBroker: new SourceBlindBroker(
        "gitleaks",
        GITLEAKS_BROKER_MANIFEST,
      ),
      workerId: "worker_e2e00001",
      scratchBase: scratchPath,
      allowedGithubAccountIds: new Set([123]),
    });
    const workResult = await worker.runOne();
    capturedLogs.push(JSON.stringify({ event: "worker_result", workResult }));
    const repositoryPage = await store.listRepositories({
      requestId: "req_e2e00000001",
      afterRepositoryId: null,
      limit: 10,
    });
    expect(
      workResult,
      JSON.stringify({
        repositories: repositoryPage.repositories,
        logs: capturedLogs,
      }),
    ).toBe("complete");

    for (const url of [
      "/api/scan-requests/req_e2e00000001",
      "/api/scan-requests/req_e2e00000001/repositories",
      "/api/operator/requests/req_e2e00000001/findings",
    ]) {
      const response = await app.request(url, {
        headers: { host: "127.0.0.1" },
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      capturedResponses.push(body);
      if (url === "/api/scan-requests/req_e2e00000001") {
        const summary = scanRequestSummarySchema.parse(JSON.parse(body));
        expect(summary.coverageTotals.zizmor.not_applicable).toBe(1);
      }
    }
    expect(capturedResponses.at(-1)).toContain(
      '"rule_id":"generic-api-key"',
    );
    expect(await readdir(scratchPath)).toEqual([]);

    store.close();
    const persistedArtifacts = await Promise.all(
      (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => readFile(path.join(root, entry.name))),
    );
    const egress = Buffer.concat([
      ...persistedArtifacts,
      Buffer.from(capturedResponses.join("\n")),
      Buffer.from(capturedLogs.join("\n")),
    ]).toString("latin1");
    // File contents and secret values may never cross egress, whatever the
    // report publishes about where a finding sits.
    const forbidden = [
      SOURCE_CANARY,
      SYNTHETIC_SECRET,
      ...eightCharacterWindows(SOURCE_CANARY),
      ...eightCharacterWindows(SYNTHETIC_SECRET),
    ];
    for (const fragment of new Set(forbidden)) {
      expect(egress, `source fragment crossed egress: ${fragment}`).not.toContain(
        fragment,
      );
    }
    // The path is published deliberately. If this stops holding, locations are
    // being dropped somewhere in the pipeline and the report is unactionable.
    expect(
      capturedResponses.at(-1),
      "published finding lost its location",
    ).toContain(PATH_CANARY);
  },
  60_000,
);
