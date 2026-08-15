import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { SqliteStore } from "@app/store-sqlite";

const enabled = process.env["RUN_CONTROL_PLANE_LOAD"] === "1";
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test.skipIf(!enabled)(
  "installs and paginates a complete 5,000-repository durable ledger",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "repo-security-load-"));
    temporaryDirectories.push(root);
    const store = new SqliteStore({
      filename: path.join(root, "store.sqlite"),
      migrationTimeMs: 1,
    });
    try {
      await store.createRequest({
        requestId: "req_load05000",
        username: "ri7in",
        nowMs: 1,
      });
      const startedAt = Date.now();
      expect(
        await store.completeDiscovery({
          requestId: "req_load05000",
          githubAccountId: 123,
          canonicalLogin: "ri7in",
          repositories: Array.from({ length: 5_000 }, (_, index) => ({
            repositoryId: index + 1,
            name: `repo-${String(index + 1).padStart(4, "0")}`,
            isFork: false,
            commitSha: "a".repeat(40),
          })),
          nowMs: 2,
        }),
      ).toBe("completed");
      const installMs = Date.now() - startedAt;

      let afterRepositoryId: number | null = null;
      let repositoryCount = 0;
      let pageCount = 0;
      do {
        const page = await store.listRepositories({
          requestId: "req_load05000",
          afterRepositoryId,
          limit: 100,
        });
        repositoryCount += page.repositories.length;
        pageCount += 1;
        afterRepositoryId = page.nextRepositoryId;
      } while (afterRepositoryId !== null);
      expect(repositoryCount).toBe(5_000);
      expect(pageCount).toBe(50);
      expect((await store.getRequest("req_load05000"))?.state).toBe("scanning");
      const firstClaim = await store.claimNext({
        workerId: "worker_load0001",
        nowMs: 3,
        leaseDurationMs: 60_000,
      });
      expect(firstClaim?.repositoryId).toBe(1);
      console.info("control-plane load summary", {
        repositories: repositoryCount,
        pages: pageCount,
        installMs,
        totalMs: Date.now() - startedAt,
      });
    } finally {
      store.close();
    }
  },
  60_000,
);
