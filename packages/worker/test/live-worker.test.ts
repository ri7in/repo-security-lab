import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { SourceBlindBroker } from "@app/broker";
import { GithubArchiveClient, GithubDiscoveryClient } from "@app/github";
import {
  GITLEAKS_BROKER_MANIFEST,
  GitleaksScanner,
} from "@app/scanners";
import { SqliteStore } from "@app/store-sqlite";
import { RepositoryWorker, type SecretScanner } from "@app/worker";

const enabled = process.env["RUN_LIVE_WORKER"] === "1";
const token = process.env["GH_TOKEN"];
const binaryPath = process.env["GITLEAKS_BINARY"];
const binaryHash = process.env["GITLEAKS_SHA256"];
const selectedNames = new Set(["ri7in.github.io", "ctse-lab-07", "CTSE-Lab05"]);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function sourceFragment(sourceDirectory: string): Promise<string | null> {
  const pending = [sourceDirectory];
  let inspectedFiles = 0;
  while (pending.length > 0 && inspectedFiles < 64) {
    const current = pending.shift();
    if (current === undefined) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile()) {
        inspectedFiles += 1;
        const bytes = await readFile(candidate);
        const text = bytes.subarray(0, 16_384).toString("utf8");
        const fragment = text.match(/[A-Za-z0-9_./:= -]{24}/u)?.[0];
        if (fragment !== undefined) return fragment;
      }
      if (inspectedFiles >= 64) break;
    }
  }
  return null;
}

test.skipIf(
  !enabled ||
    token === undefined ||
    binaryPath === undefined ||
    binaryHash === undefined,
)(
  "scans three paced Rivin-authored repositories through the real worker",
  async () => {
    if (
      token === undefined ||
      binaryPath === undefined ||
      binaryHash === undefined
    ) {
      throw new Error("live worker prerequisites missing");
    }
    const root = await mkdtemp(path.join(tmpdir(), "repo-security-live-worker-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "store.sqlite");
    const scratchPath = path.join(root, "scratch");
    const discoveryStarted = Date.now();
    const discovery = await new GithubDiscoveryClient({ token }).discover("ri7in");
    const selected = discovery.account.repositories.filter((repository) =>
      selectedNames.has(repository.name),
    );
    expect(selected).toHaveLength(selectedNames.size);
    expect(selected.every((repository) => !repository.isFork)).toBe(true);
    expect(selected.every((repository) => repository.commitSha !== null)).toBe(true);

    const store = new SqliteStore({ filename: databasePath, migrationTimeMs: 1 });
    await store.createRequest({
      requestId: "req_liveworker01",
      username: "ri7in",
      nowMs: Date.now(),
    });
    await store.completeDiscovery({
      requestId: "req_liveworker01",
      githubAccountId: discovery.account.githubAccountId,
      canonicalLogin: discovery.account.canonicalLogin,
      repositories: selected,
      nowMs: Date.now(),
    });

    const realScanner = new GitleaksScanner({
      binaryPath,
      expectedBinarySha256: binaryHash,
    });
    const fragments: string[] = [];
    const scanner: SecretScanner = {
      async scan(sourceDirectory) {
        const fragment = await sourceFragment(sourceDirectory);
        if (fragment !== null) fragments.push(fragment);
        return await realScanner.scan(sourceDirectory);
      },
    };
    const worker = new RepositoryWorker({
      store,
      archiveFetcher: new GithubArchiveClient({
        token,
        minimumIntervalMs: 2_000,
      }),
      gitleaks: scanner,
      gitleaksBroker: new SourceBlindBroker(
        "gitleaks",
        GITLEAKS_BROKER_MANIFEST,
      ),
      workerId: "worker_live0001",
      scratchBase: scratchPath,
      allowedGithubAccountIds: new Set([discovery.account.githubAccountId]),
    });
    const results: string[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      results.push(await worker.runOne());
    }
    expect(results.every((result) => result === "complete" || result === "partial")).toBe(
      true,
    );
    expect(await worker.runOne()).toBe("idle");
    expect(await readdir(scratchPath)).toEqual([]);
    const repositoryPage = await store.listRepositories({
      requestId: "req_liveworker01",
      afterRepositoryId: null,
      limit: 10,
    });
    const findingPage = await store.listFindings({
      requestId: "req_liveworker01",
      afterFindingId: null,
      limit: 100,
    });
    store.close();
    const database = (await readFile(databasePath)).toString("latin1");
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) expect(database).not.toContain(fragment);
    console.info(
      "live worker summary",
      JSON.stringify({
        repositories: repositoryPage.repositories.map((repository) => ({
          name: repository.name,
          state: repository.state,
          coverage: repository.coverage,
        })),
        findingCount: findingPage.findings.length,
        discoveryMs: Date.now() - discoveryStarted,
      }),
    );
  },
  5 * 60_000,
);
