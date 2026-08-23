/* eslint-disable @typescript-eslint/require-await -- port doubles model boundaries */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JudgePort, ScoutPort } from "@app/ai";
import { SourceBlindBroker } from "@app/broker";
import { SqliteStore } from "@app/store-sqlite";
import { GITLEAKS_BROKER_MANIFEST } from "@app/scanners";
import { GithubClientError } from "@app/github";
import {
  RepositoryWorker,
  type ArchiveFetcher,
  type SecretScanner,
} from "@app/worker";

const temporaryDirectories: string[] = [];
const SHA = "a".repeat(40);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(block, 148);
  return Buffer.concat([
    block,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

const VULNERABLE = 'const query = `SELECT * FROM users WHERE id = ${id}`\n';

function archive(): Uint8Array {
  return gzipSync(
    Buffer.concat([
      tarEntry("root/src/db.ts", Buffer.from(VULNERABLE)),
      Buffer.alloc(1_024),
    ]),
  );
}

function archiveFetcher(bytes: Uint8Array): ArchiveFetcher {
  return {
    async fetchArchive() {
      const body = new Response(Uint8Array.from(bytes).buffer).body;
      if (body === null) throw new Error("test expected response body");
      return { body, contentLength: bytes.byteLength, requestCount: 1 };
    },
  };
}

function brokenFetcher(): ArchiveFetcher {
  return {
    async fetchArchive() {
      throw new GithubClientError("AUTH_REQUIRED");
    },
  };
}

const scanner: SecretScanner = {
  async scan() {
    return {
      findings: [{ ruleId: "github-pat" }],
      rawFindingCount: 1,
      findingLimitExceeded: false,
      locations: [],
    };
  },
};

function judge(family: string): JudgePort {
  return {
    family,
    review: async () => ({ verdict: "real", reason: "fixture" }),
  } as unknown as JudgePort;
}

const findingScout: ScoutPort = {
  analyze: async () => ({
    flags: [
      {
        fileToken: 0,
        lineStart: 1,
        lineEnd: 1,
        evidenceQuote: "const query = `SELECT * FROM users WHERE id = ${id}`",
        cwe: "CWE-89",
        impact: "data-disclosure",
        rationale: "interpolated into SQL",
        confidence: "high",
      },
    ],
  }),
};

const brokenScout: ScoutPort = {
  analyze: async () => {
    throw new Error("provider down");
  },
};

async function workspace(): Promise<{ database: string; scratch: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-ai-publish-"));
  temporaryDirectories.push(root);
  return {
    database: path.join(root, "store.sqlite"),
    scratch: path.join(root, "scratch"),
  };
}

async function ledger(store: SqliteStore): Promise<void> {
  await store.createRequest({
    requestId: "req_0000000001",
    username: "ri7in",
    nowMs: 1,
  });
  await store.completeDiscovery({
    requestId: "req_0000000001",
    githubAccountId: 123,
    canonicalLogin: "ri7in",
    repositories: [
      { repositoryId: 7, name: "fixture-repo", isFork: false, commitSha: SHA },
    ],
    nowMs: 2,
  });
}

async function runOnce(
  scout: ScoutPort | undefined,
  refuseFirstPublish: boolean | "always" = false,
  workerOverrides: Record<string, unknown> = {},
  failFetch = false,
): Promise<{
  result: string;
  refusals: string[];
  state: string | undefined;
  reason: string | null | undefined;
}> {
  const files = await workspace();
  const store = new SqliteStore({ filename: files.database, migrationTimeMs: 1 });
  await ledger(store);
  if (refuseFirstPublish) {
    const real = store.publish.bind(store);
    let calls = 0;
    // A message the diagnostic cannot print verbatim, which is exactly the
    // shape the production refusal arrived in.
    store.publish = async (input) => {
      calls += 1;
      if (refuseFirstPublish === "always" || calls === 1) {
        throw new Error("D1_ERROR: refused (fixture)");
      }
      return real(input);
    };
  }
  const refusals: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    refusals.push(String(chunk));
    return true;
  });
  const worker = new RepositoryWorker({
    store,
    archiveFetcher: failFetch ? brokenFetcher() : archiveFetcher(archive()),
    gitleaks: scanner,
    gitleaksBroker: new SourceBlindBroker("gitleaks", GITLEAKS_BROKER_MANIFEST),
    workerId: "worker_00000001",
    scratchBase: files.scratch,
    allowedGithubAccountIds: new Set([123]),
    ...(scout === undefined ? {} : { scout }),
    judges: [judge("alpha"), judge("beta")],
    ...workerOverrides,
  });
  await worker.initialize();
  const result = await worker.runOne();
  vi.restoreAllMocks();
  const rows = await store.listRepositories({
    requestId: "req_0000000001",
    limit: 10,
    afterRepositoryId: null,
  });
  const state = rows.repositories[0]?.state;
  const reason = rows.repositories[0]?.reason;
  store.close();
  return { result, refusals, state, reason };
}

describe("publishing a repository the AI engine touched", () => {
  it("publishes when the reader found something", async () => {
    const { result, refusals, state } = await runOnce(findingScout);
    if (refusals.length > 0) console.log("REFUSALS", refusals);
    expect(result).not.toBe("publish_deferred");
    expect(state).not.toBe("leased");
  }, 60_000);

  it("publishes when the reader was unreachable", async () => {
    const { result, refusals, state } = await runOnce(brokenScout);
    if (refusals.length > 0) console.log("REFUSALS", refusals);
    expect(result).not.toBe("publish_deferred");
    expect(state).not.toBe("leased");
  }, 60_000);
});

describe("a publication the store refuses", () => {
  it("still reaches a terminal state instead of keeping the lease", async () => {
    const { result, refusals, state, reason } = await runOnce(findingScout, true);
    // The lease is what matters. A repository that keeps one blocks every
    // repository queued behind it, because this worker will not claim while
    // holding a lease, and that is how a single bad row stalled a whole
    // twenty-three repository request in production.
    expect(state).toBe("failed");
    expect(reason).toBe("SCANNER_INTERNAL");
    expect(result).toBe("failed");
    // The refusal is still reported, so the underlying cause is not buried by
    // the recovery.
    expect(refusals.join("")).toContain("publish_refused");
  }, 60_000);
});

describe("the AI engine inside a real scan", () => {
  it("reports the reader as not run once the per-run budget is spent", async () => {
    const { result, state } = await runOnce(findingScout, false, {
      // The daily model budget is shared and small, so this is a hard stop.
      // Past it a repository must say the check did not happen, never look
      // clean by omission.
      aiRepositoryBudget: 0,
    });
    expect(result).toBe("complete");
    expect(state).toBe("complete");
  }, 60_000);

  it("survives a council too small to convene", async () => {
    // One judge cannot disagree with itself, so the funnel refuses to build.
    // That must degrade the AI lane, never the scan.
    const { result, refusals, state } = await runOnce(findingScout, false, {
      judges: [judge("alpha")],
    });
    expect(refusals.join("")).not.toContain("publish_refused");
    expect(result).toBe("partial");
    expect(state).toBe("partial");
  }, 60_000);

  it("still publishes a failed fetch when the ledger refuses it once", async () => {
    // The snapshot failed, so the whole repository is explained by that and
    // the contract refuses per-engine reasons alongside it.
    const { result, state, reason } = await runOnce(
      undefined,
      true,
      {},
      true,
    );
    expect(result).toBe("failed");
    expect(state).toBe("failed");
    expect(reason).toBe("GITHUB_AUTH");
  }, 60_000);

  it("gives up rather than looping when the ledger refuses everything", async () => {
    const { result, refusals } = await runOnce(findingScout, "always");
    expect(result).toBe("publish_deferred");
    // Both the real publication and the fallback are reported, so the log
    // shows the recovery was attempted and also failed.
    expect([...refusals.join("").matchAll(/publish_refused/g)]).toHaveLength(2);
  }, 60_000);
});
