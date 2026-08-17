/* eslint-disable @typescript-eslint/require-await -- worker port doubles model asynchronous boundaries */
import {
  chmod,
  lstat,
  readFile,
  readdir,
  writeFile,
  mkdtemp,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceBlindBroker } from "@app/broker";
import { GithubClientError, type GithubErrorCode } from "@app/github";
import { SqliteStore } from "@app/store-sqlite";
import { GITLEAKS_BROKER_MANIFEST, ScannerError } from "@app/scanners";
import {
  RepositoryWorker,
  scratchPathFor,
  type ArchiveFetcher,
  type AdditionalEngineRunner,
  type RepositoryScanDomain,
  type SecretScanner,
} from "@app/worker";
import * as applicability from "../src/applicability.js";

const temporaryDirectories: string[] = [];
const SHA = "a".repeat(40);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<{ root: string; database: string; scratch: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-worker-"));
  temporaryDirectories.push(root);
  return {
    root,
    database: path.join(root, "store.sqlite"),
    scratch: path.join(root, "scratch"),
  };
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tarEntry(name: string, data: Buffer): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  octal(0o600, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(data.length, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write("0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    block,
    148,
  );
  return Buffer.concat([
    block,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

function archiveEntries(
  entries: ReadonlyArray<{ readonly name: string; readonly content: string }>,
): Uint8Array {
  return gzipSync(
    Buffer.concat([
      ...entries.map((entry) =>
        tarEntry(entry.name, Buffer.from(entry.content)),
      ),
      Buffer.alloc(1_024),
    ]),
  );
}

function archive(name = "root/file.txt", content = "safe fixture"): Uint8Array {
  return archiveEntries([{ name, content }]);
}

function mixedApplicabilityArchive(): Uint8Array {
  return archiveEntries([
    { name: "root/.github/workflows/ci.yml", content: "name: ci" },
    { name: "root/package-lock.json", content: "{}" },
    { name: "root/src/app.ts", content: "export {};" },
    { name: "root/credential.txt", content: "safe fixture" },
  ]);
}

function archiveFetcher(bytes: Uint8Array, onFetch?: () => void): ArchiveFetcher {
  return {
    async fetchArchive() {
      onFetch?.();
      const body = new Response(Uint8Array.from(bytes).buffer).body;
      if (body === null) throw new Error("test expected response body");
      return { body, contentLength: bytes.byteLength, requestCount: 1 };
    },
  };
}

function failingArchiveFetcher(code: GithubErrorCode): ArchiveFetcher {
  return {
    async fetchArchive() {
      throw new GithubClientError(code);
    },
  };
}

function interruptedArchiveFetcher(): ArchiveFetcher {
  return {
    async fetchArchive() {
      let pulled = false;
      return {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!pulled) {
              pulled = true;
              controller.enqueue(Uint8Array.from([0x1f, 0x8b]));
              return;
            }
            controller.error(new GithubClientError("NETWORK_FAILED"));
          },
        }),
        contentLength: null,
        requestCount: 1,
      };
    },
  };
}

async function createLedger(
  store: SqliteStore,
  githubAccountId = 123,
  isFork = false,
): Promise<void> {
  await store.createRequest({
    requestId: "req_0000000001",
    username: "ri7in",
    nowMs: 1,
  });
  await store.completeDiscovery({
    requestId: "req_0000000001",
    githubAccountId,
    canonicalLogin: "ri7in",
    repositories: [
      {
        repositoryId: 7,
        name: "fixture-repo",
        isFork,
        commitSha: SHA,
      },
    ],
    nowMs: 2,
  });
}

function scanner(assertSource?: (sourceDirectory: string) => Promise<void>): SecretScanner {
  return {
    async scan(sourceDirectory) {
      await assertSource?.(sourceDirectory);
      return {
        findings: [{ ruleId: "github-pat" }],
        rawFindingCount: 1,
        findingLimitExceeded: false,
      };
    },
  };
}

function additionalEngine(
  engine: AdditionalEngineRunner["engine"],
  implementation: NonNullable<AdditionalEngineRunner["scanAndNormalize"]>,
): AdditionalEngineRunner {
  return {
    engine,
    broker: new SourceBlindBroker(engine, [
      {
        token: 1,
        ruleId: `${engine}-fixture-rule`,
        category: "code",
        severity: "high",
        confidence: "high",
        remediationKey: "review-fixture",
      },
    ]),
    scanAndNormalize: implementation,
  };
}

function oneGroupPacket(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 1, groups: [{ token: 1, bucket: 0 }] }),
  );
}

function worker(
  store: SqliteStore,
  scratch: string,
  fetcher: ArchiveFetcher,
  secretScanner: SecretScanner = scanner(),
  overrides: Partial<ConstructorParameters<typeof RepositoryWorker>[0]> = {},
): RepositoryWorker {
  return new RepositoryWorker({
    store,
    archiveFetcher: fetcher,
    gitleaks: secretScanner,
    gitleaksBroker: new SourceBlindBroker("gitleaks", GITLEAKS_BROKER_MANIFEST),
    workerId: "worker_00000001",
    scratchBase: scratch,
    allowedGithubAccountIds: new Set([123]),
    ...overrides,
  });
}

describe("leased repository worker", () => {
  it("requires a verified isolation domain before public construction", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    expect(() =>
      worker(store, files.scratch, archiveFetcher(archive()), scanner(), {
        allowedGithubAccountIds: null,
      }),
    ).toThrow("public worker requires enforced scan isolation");

    const unverifiedDomain: RepositoryScanDomain = {
      enforcedIsolation: false,
      async guardAndExtract() {},
      async scan() {
        return {
          applicability: { osv: false, zizmor: false, opengrep: false },
          engineResults: [],
          engineFailures: {},
        };
      },
    };
    expect(() =>
      worker(store, files.scratch, archiveFetcher(archive()), scanner(), {
        allowedGithubAccountIds: null,
        scanDomain: unverifiedDomain,
      }),
    ).toThrow("public worker requires enforced scan isolation");
    store.close();
  });

  it("refuses a configured scratch root that is itself a symlink", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    const actual = path.join(files.root, "actual-scratch");
    await mkdir(actual);
    await symlink(actual, files.scratch);
    await expect(
      worker(store, files.scratch, archiveFetcher(archive())).initialize(),
    ).rejects.toThrow("invalid worker scratch root");
    store.close();
  });

  it("refuses a permissive existing scratch root without changing its mode", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await mkdir(files.scratch, { mode: 0o755 });
    await chmod(files.scratch, 0o755);
    await expect(
      worker(store, files.scratch, archiveFetcher(archive())).initialize(),
    ).rejects.toThrow("invalid worker scratch root");
    expect((await lstat(files.scratch)).mode & 0o777).toBe(0o755);
    store.close();
  });

  it("runs fetch→guard→scan→normalize→cleanup→broker→durable publish", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const canary = "RVN_SOURCE_CANARY_39f0";
    const result = await worker(
      store,
      files.scratch,
      archiveFetcher(archive("root/file.txt", canary)),
      scanner(async (sourceDirectory) => {
        expect(await readFile(path.join(sourceDirectory, "root/file.txt"), "utf8")).toBe(
          canary,
        );
      }),
    ).runOne();

    expect(result).toBe("complete");
    const repositories = await store.listRepositories({
      requestId: "req_0000000001",
      afterRepositoryId: null,
      limit: 10,
    });
    expect(repositories.repositories[0]).toMatchObject({
      state: "complete",
      coverage: {
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks: "complete",
        osv: "not_applicable",
        zizmor: "not_applicable",
        opengrep: "not_applicable",
      },
    });
    const findings = await store.listFindings({
      requestId: "req_0000000001",
      afterFindingId: null,
      limit: 10,
    });
    expect(findings.findings[0]).toMatchObject({
      engine: "gitleaks",
      rule_id: "github-pat",
      occurrence_bucket: "one",
    });
    expect(await readdir(files.scratch)).toEqual([]);
    store.close();
    expect((await readFile(files.database)).includes(Buffer.from(canary))).toBe(false);
  });

  it("reports present but unintegrated specialist inputs as unsupported", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(mixedApplicabilityArchive()),
      ).runOne(),
    ).toBe("complete");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "complete",
      coverage: {
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks: "complete",
        osv: "unsupported",
        zizmor: "unsupported",
        opengrep: "unsupported",
      },
    });
    expect(await readdir(files.scratch)).toEqual([]);
    store.close();
  });

  it("retains concrete applicability when Gitleaks fails", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const failingScanner: SecretScanner = {
      scan() {
        return Promise.reject(new ScannerError("SCANNER_TIMEOUT"));
      },
    };
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(
          archiveEntries([
            { name: "root/package.json", content: "{}" },
            { name: "root/readme.txt", content: "safe fixture" },
          ]),
        ),
        failingScanner,
      ).runOne(),
    ).toBe("failed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "failed",
      reason: "SCANNER_TIMEOUT",
      coverage: {
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks: "failed",
        osv: "unsupported",
        zizmor: "not_applicable",
        opengrep: "not_applicable",
      },
    });
    store.close();
  });

  it("keeps unknown applicability unsupported on a successful row", async () => {
    vi.spyOn(applicability, "detectSpecialistApplicability").mockResolvedValueOnce(
      null,
    );
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(archive()),
      ).runOne(),
    ).toBe("complete");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "complete",
      coverage: {
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks: "complete",
        osv: "unsupported",
        zizmor: "unsupported",
        opengrep: "unsupported",
      },
    });
    store.close();
  });

  it("keeps unknown unrun specialists unsupported on a failed row", async () => {
    vi.spyOn(applicability, "detectSpecialistApplicability").mockResolvedValueOnce(
      null,
    );
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const failingScanner: SecretScanner = {
      scan() {
        return Promise.reject(new ScannerError("SCANNER_INTERNAL"));
      },
    };
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(archive()),
        failingScanner,
      ).runOne(),
    ).toBe("failed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "failed",
      reason: "SCANNER_INTERNAL",
      coverage: {
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks: "failed",
        osv: "unsupported",
        zizmor: "unsupported",
        opengrep: "unsupported",
      },
    });
    store.close();
  });

  it("retains Gitleaks evidence when an applicable second engine fails", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const result = await worker(
      store,
      files.scratch,
      archiveFetcher(mixedApplicabilityArchive()),
      scanner(),
      {
        additionalEngines: [
          additionalEngine("osv", async () => {
            throw new ScannerError("SCANNER_TIMEOUT");
          }),
        ],
      },
    ).runOne();

    expect(result).toBe("partial");
    const repository = (
      await store.listRepositories({
        requestId: "req_0000000001",
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(repository).toMatchObject({
      state: "partial",
      reason: "SCANNER_TIMEOUT",
      specialistReasons: { osv: "SCANNER_TIMEOUT" },
      coverage: { gitleaks: "complete", osv: "failed" },
    });
    expect(
      await store.listFindings({
        requestId: "req_0000000001",
        afterFindingId: null,
        limit: 10,
      }),
    ).toMatchObject({ findings: [{ engine: "gitleaks", rule_id: "github-pat" }] });
    store.close();
  });

  it("retains second-engine evidence when Gitleaks fails", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const failingScanner: SecretScanner = {
      scan() {
        return Promise.reject(new ScannerError("SCANNER_TIMEOUT"));
      },
    };
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(mixedApplicabilityArchive()),
        failingScanner,
        {
          additionalEngines: [
            additionalEngine("osv", async () => ({
              packetBytes: oneGroupPacket(),
              coverage: "complete",
              reason: null,
            })),
          ],
        },
      ).runOne(),
    ).toBe("partial");
    const repository = (
      await store.listRepositories({
        requestId: "req_0000000001",
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(repository).toMatchObject({
      state: "partial",
      reason: "SCANNER_TIMEOUT",
      specialistReasons: { gitleaks: "SCANNER_TIMEOUT" },
      coverage: { gitleaks: "failed", osv: "complete" },
    });
    expect(
      await store.listFindings({
        requestId: "req_0000000001",
        afterFindingId: null,
        limit: 10,
      }),
    ).toMatchObject({ findings: [{ engine: "osv", rule_id: "osv-fixture-rule" }] });
    store.close();
  });

  it("retains concrete applicability when broker validation rejects", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(mixedApplicabilityArchive()),
        scanner(),
        { gitleaksBroker: new SourceBlindBroker("gitleaks", []) },
      ).runOne(),
    ).toBe("failed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "failed",
      reason: "NORMALIZATION_REJECTED",
      coverage: {
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks: "failed",
        osv: "unsupported",
        zizmor: "unsupported",
        opengrep: "unsupported",
      },
    });
    store.close();
  });

  it("keeps concrete absence determinations on a finding-limit partial row", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const limitedScanner: SecretScanner = {
      async scan() {
        return {
          findings: Array.from({ length: 10_000 }, () => ({
            ruleId: "github-pat",
          })),
          rawFindingCount: 10_001,
          findingLimitExceeded: true,
        };
      },
    };
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(archive()),
        limitedScanner,
      ).runOne(),
    ).toBe("partial");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "partial",
      reason: "FINDING_LIMIT",
      coverage: {
        snapshot: "complete",
        archive_guard: "complete",
        gitleaks: "partial",
        osv: "not_applicable",
        zizmor: "not_applicable",
        opengrep: "not_applicable",
      },
    });
    store.close();
  });

  it("double-enforces the immutable account allowlist before archive access", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store, 999);
    let fetched = false;
    const result = await worker(
      store,
      files.scratch,
      archiveFetcher(archive(), () => {
        fetched = true;
      }),
    ).runOne();
    expect(result).toBe("scope_refused");
    expect(fetched).toBe(false);
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "cancelled",
      reason: "PRIVATE_SLICE_SCOPE",
      coverage: {
        snapshot: "not_applicable",
        archive_guard: "not_applicable",
        gitleaks: "not_applicable",
        osv: "not_applicable",
        zizmor: "not_applicable",
        opengrep: "not_applicable",
      },
    });
    store.close();
  });

  it("refuses account-owned forks because their source is third-party", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store, 123, true);
    let fetched = false;
    const result = await worker(
      store,
      files.scratch,
      archiveFetcher(archive(), () => {
        fetched = true;
      }),
    ).runOne();
    expect(result).toBe("scope_refused");
    expect(fetched).toBe(false);
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "cancelled",
      reason: "PRIVATE_SLICE_SCOPE",
      coverage: {
        snapshot: "not_applicable",
        archive_guard: "not_applicable",
        gitleaks: "not_applicable",
        osv: "not_applicable",
        zizmor: "not_applicable",
        opengrep: "not_applicable",
      },
    });
    store.close();
  });

  it("fails an unsafe archive explicitly and removes every source byte", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    expect(
      await worker(
        store,
        files.scratch,
        archiveFetcher(archive("../escape", "RVN_ESCAPE")),
      ).runOne(),
    ).toBe("failed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "failed",
      reason: "ARCHIVE_UNSAFE",
      attemptCount: 1,
      coverage: {
        snapshot: "complete",
        archive_guard: "failed",
        gitleaks: "failed",
        osv: "failed",
        zizmor: "failed",
        opengrep: "failed",
      },
    });
    expect(await readdir(files.scratch)).toEqual([]);
    store.close();
  });

  it("requeues a cleaned first rate-limit failure under a new generation", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    expect(
      await worker(
        store,
        files.scratch,
        failingArchiveFetcher("RATE_LIMITED"),
      ).runOne(),
    ).toBe("retry_queued");
    const waiting = (
      await store.listRepositories({
        requestId: "req_0000000001",
        afterRepositoryId: null,
        limit: 10,
      })
    ).repositories[0];
    expect(waiting).toMatchObject({
      state: "waiting",
      reason: null,
      attemptCount: 1,
      lease: null,
    });
    expect(await readdir(files.scratch)).toEqual([]);
    const next = await store.claimNext({
      workerId: "worker_00000002",
      nowMs: Date.now(),
      leaseDurationMs: 60_000,
    });
    expect(next).toMatchObject({ attemptCount: 2, leaseGeneration: 2 });
    store.close();
  });

  it("retries rate limits twice, then publishes the honest final cause", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const repositoryWorker = worker(
      store,
      files.scratch,
      failingArchiveFetcher("RATE_LIMITED"),
    );
    expect(await repositoryWorker.runOne()).toBe("retry_queued");
    expect(await repositoryWorker.runOne()).toBe("retry_queued");
    expect(await repositoryWorker.runOne()).toBe("failed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "failed",
      reason: "GITHUB_RATE_LIMIT",
      attemptCount: 3,
      coverage: {
        snapshot: "failed",
        archive_guard: "failed",
        gitleaks: "failed",
        osv: "failed",
        zizmor: "failed",
        opengrep: "failed",
      },
    });
    expect(
      await store.listFindings({
        requestId: "req_0000000001",
        afterFindingId: null,
        limit: 10,
      }),
    ).toMatchObject({ findings: [] });
    expect(await readdir(files.scratch)).toEqual([]);
    store.close();
  });

  it("classifies an interrupted archive stream as a retryable GitHub network failure", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const repositoryWorker = worker(
      store,
      files.scratch,
      interruptedArchiveFetcher(),
    );
    expect(await repositoryWorker.runOne()).toBe("retry_queued");
    expect(await repositoryWorker.runOne()).toBe("retry_queued");
    expect(await repositoryWorker.runOne()).toBe("failed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({ state: "failed", reason: "GITHUB_NETWORK" });
    expect(await readdir(files.scratch)).toEqual([]);
    store.close();
  });

  it("terminalizes GitHub authentication failure on the first attempt", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    expect(
      await worker(
        store,
        files.scratch,
        failingArchiveFetcher("AUTH_REQUIRED"),
      ).runOne(),
    ).toBe("failed");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "failed",
      reason: "GITHUB_AUTH",
      attemptCount: 1,
      coverage: {
        snapshot: "failed",
        archive_guard: "failed",
        gitleaks: "failed",
        osv: "failed",
        zizmor: "failed",
        opengrep: "failed",
      },
    });
    expect(await readdir(files.scratch)).toEqual([]);
    store.close();
  });

  it("never terminalizes when cleanup verification fails", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const result = await worker(store, files.scratch, archiveFetcher(archive()), scanner(), {
      removeScratch: async () => false,
    }).runOne();
    expect(result).toBe("cleanup_pending");
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0]?.state,
    ).toBe("cleaning");
    store.close();
  });

  it("removes source immediately when the lease expires before cleaning", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const times = [1_000, 1_001, 1_002, 601_001, 601_002];
    const repositoryWorker = worker(
      store,
      files.scratch,
      archiveFetcher(archive("root/file.txt", "RVN_EXPIRED_SOURCE")),
      scanner(),
      {
        leaseDurationMs: 10 * 60 * 1_000,
        now: () => times.shift() ?? 601_003,
      },
    );

    expect(await repositoryWorker.runOne()).toBe("stale_lease");
    expect(await readdir(files.scratch)).toEqual([]);
    expect(await repositoryWorker.reapExpired()).toEqual({
      requeuedCleaned: 1,
      exhaustedFinalized: 0,
    });
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0]?.state,
    ).toBe("waiting");
    store.close();
  });

  it("reports a late stale transition after successful scanning without rewriting coverage", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const transition = store.transition.bind(store);
    vi.spyOn(store, "transition").mockImplementation(async (input) =>
      input.nextState === "uploading" ? false : transition(input),
    );

    expect(
      await worker(store, files.scratch, archiveFetcher(archive())).runOne(),
    ).toBe("stale_lease");
    expect(await readdir(files.scratch)).toEqual([]);
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({
      state: "cleaning",
      coverage: { gitleaks: "waiting" },
    });
    store.close();
  });

  it("removes a pre-existing exact tuple root before publishing the failure", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const exactRoot = scratchPathFor(files.scratch, {
      requestId: "req_0000000001",
      repositoryId: 7,
      generation: 1,
    });
    const repositoryWorker = worker(
      store,
      files.scratch,
      archiveFetcher(archive()),
    );
    await repositoryWorker.initialize();
    await mkdir(exactRoot, { recursive: true });
    await writeFile(path.join(exactRoot, "orphan-source"), "RVN_ORPHAN_SOURCE");
    expect(await repositoryWorker.runOne()).toBe("failed");
    expect(await readdir(files.scratch)).toEqual([]);
    expect(
      (
        await store.listRepositories({
          requestId: "req_0000000001",
          afterRepositoryId: null,
          limit: 10,
        })
      ).repositories[0],
    ).toMatchObject({ state: "failed", reason: "SCANNER_INTERNAL" });
    store.close();
  });

  it("removes the exact stale-generation scratch root returned by requeue", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    const claim = await store.claimNext({
      workerId: "worker_00000009",
      nowMs: 1_000,
      leaseDurationMs: 60_000,
    });
    if (claim === null) throw new Error("test expected claim");
    const exactRoot = scratchPathFor(files.scratch, {
      requestId: claim.requestId,
      repositoryId: claim.repositoryId,
      generation: claim.leaseGeneration,
    });
    await mkdir(exactRoot, { recursive: true });
    await writeFile(path.join(exactRoot, "source"), "RVN_STALE_SOURCE");
    const repositoryWorker = worker(store, files.scratch, archiveFetcher(archive()), scanner(), {
      now: () => 61_000,
    });
    expect(await repositoryWorker.reapExpired()).toEqual({
      requeuedCleaned: 1,
      exhaustedFinalized: 0,
    });
    await expect(readFile(path.join(exactRoot, "source"))).rejects.toThrow();
    store.close();
  });

  it("keeps an expired retry unclaimable until stale cleanup is proven", async () => {
    const files = await workspace();
    const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
    await createLedger(store);
    expect(
      await store.claimNext({
        workerId: "worker_00000009",
        nowMs: 1_000,
        leaseDurationMs: 60_000,
      }),
    ).not.toBeNull();
    const repositoryWorker = worker(
      store,
      files.scratch,
      archiveFetcher(archive()),
      scanner(),
      { now: () => 61_000, removeScratch: async () => false },
    );
    expect(await repositoryWorker.reapExpired()).toEqual({
      requeuedCleaned: 0,
      exhaustedFinalized: 0,
    });
    expect(
      await store.claimNext({
        workerId: "worker_00000010",
        nowMs: 61_001,
        leaseDurationMs: 60_000,
      }),
    ).toBeNull();
    store.close();
  });
});
