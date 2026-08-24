/* eslint-disable @typescript-eslint/require-await -- port doubles model boundaries */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { JudgePort, ScoutPort } from "@app/ai";
import { SourceBlindBroker } from "@app/broker";
import { SqliteStore } from "@app/store-sqlite";
import { GITLEAKS_BROKER_MANIFEST } from "@app/scanners";
import {
  RepositoryWorker,
  type ArchiveFetcher,
  type SecretScanner,
} from "@app/worker";

const temporaryDirectories: string[] = [];
const SHA = "a".repeat(40);

afterEach(async () => {
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

function archive(): Uint8Array {
  return gzipSync(
    Buffer.concat([
      tarEntry("root/src/db.ts", Buffer.from("const x = 1\n")),
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

const scanner: SecretScanner = {
  async scan() {
    return {
      findings: [],
      rawFindingCount: 0,
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

/** A flagless scout that remembers being asked, which is the whole point. */
function countingScout(): ScoutPort & { calls: number } {
  const scout = {
    calls: 0,
    analyze: async () => {
      scout.calls += 1;
      return { flags: [] };
    },
  };
  return scout;
}

async function drain(
  aiEligible: readonly (boolean | undefined)[],
): Promise<{ scoutCalls: number; aiCoverage: readonly string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-deep-read-"));
  temporaryDirectories.push(root);
  const store = new SqliteStore({
    filename: path.join(root, "store.sqlite"),
    migrationTimeMs: 1,
  });
  await store.createRequest({
    requestId: "req_0000000001",
    username: "ri7in",
    nowMs: 1,
  });
  await store.completeDiscovery({
    requestId: "req_0000000001",
    githubAccountId: 123,
    canonicalLogin: "ri7in",
    repositories: aiEligible.map((eligible, index) => ({
      repositoryId: index + 1,
      name: `fixture-repo-${String(index + 1)}`,
      isFork: false,
      commitSha: SHA,
      ...(eligible === undefined ? {} : { aiEligible: eligible }),
    })),
    nowMs: 2,
  });
  const scout = countingScout();
  const worker = new RepositoryWorker({
    store,
    archiveFetcher: archiveFetcher(archive()),
    gitleaks: scanner,
    gitleaksBroker: new SourceBlindBroker("gitleaks", GITLEAKS_BROKER_MANIFEST),
    workerId: "worker_00000001",
    scratchBase: path.join(root, "scratch"),
    allowedGithubAccountIds: new Set([123]),
    scout,
    judges: [judge("alpha"), judge("beta")],
  });
  await worker.initialize();
  for (let claim = 0; claim < aiEligible.length; claim += 1) {
    await worker.runOne();
  }
  const rows = await store.listRepositories({
    requestId: "req_0000000001",
    limit: 10,
    afterRepositoryId: null,
  });
  store.close();
  return {
    scoutCalls: scout.calls,
    aiCoverage: rows.repositories.map((row) => row.coverage.ai),
  };
}

describe("the deep-read slot gate", () => {
  it("never reads a repository that lost its request's slots", async () => {
    const { scoutCalls, aiCoverage } = await drain([false, true]);
    // Repository 1 lost the slot: the model was never asked about it and its
    // lane says so. Repository 2 won and was read.
    expect(aiCoverage).toEqual(["unsupported", "complete"]);
    expect(scoutCalls).toBe(1);
  }, 60_000);

  it("keeps the old first-claimed behaviour for rows without a mark", async () => {
    const { scoutCalls, aiCoverage } = await drain([undefined, undefined]);
    expect(aiCoverage).toEqual(["complete", "complete"]);
    expect(scoutCalls).toBe(2);
  }, 60_000);
});
