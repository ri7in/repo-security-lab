import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { GithubArchiveClient, GithubDiscoveryClient } from "@app/github";
import { extractTarGzip } from "@app/archive";

const enabled = process.env["RUN_LIVE_GITHUB"] === "1";
const token = process.env["GH_TOKEN"];
const temporaryDirectories: string[] = [];

async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test.skipIf(!enabled || token === undefined)(
  "fetches and guards one Rivin-authored immutable archive",
  async () => {
    if (token === undefined) throw new Error("live GitHub token is unavailable");
    const startedAt = Date.now();
    const discovery = await new GithubDiscoveryClient({ token }).discover("ri7in");
    const repository = discovery.account.repositories.find(
      (candidate) => candidate.name === "myslt-alerts" && !candidate.isFork,
    );
    if (repository?.commitSha === null || repository?.commitSha === undefined) {
      throw new Error("authorized live fixture is unavailable");
    }

    const download = await new GithubArchiveClient({
      token,
      minimumIntervalMs: 0,
    }).fetchArchive({
      owner: discovery.account.canonicalLogin,
      repository: repository.name,
      commitSha: repository.commitSha,
    });
    const parent = await mkdtemp(path.join(tmpdir(), "repo-security-live-"));
    temporaryDirectories.push(parent);
    const report = await extractTarGzip(
      streamChunks(download.body),
      path.join(parent, "extracted"),
    );

    expect(report.regularFileCount).toBeGreaterThan(0);
    expect(report.entryCount).toBeGreaterThanOrEqual(report.regularFileCount);
    console.log("live archive summary", {
      repository: "ri7in/myslt-alerts",
      discoveryRequests: discovery.requestCount,
      archiveRequests: download.requestCount,
      compressedBytes: report.compressedBytes,
      entryCount: report.entryCount,
      regularFileCount: report.regularFileCount,
      directoryCount: report.directoryCount,
      elapsedMs: Date.now() - startedAt,
    });
  },
  60_000,
);
