import { env } from "cloudflare:workers";
import type { OpaqueId } from "@app/contracts";
import { D1Store } from "@app/store-d1";
import { describe, it } from "vitest";

// Its own file on purpose: the claim test leaves a live lease and a scanning
// request behind, and the store's claim pool is global, so inside the shared
// d1-store file that residue was claimed by unrelated tests further down.

describe("deep-read slot mark in D1", () => {
  it("persists through the JSON ledger and the claim", async ({ expect }) => {
    const store = new D1Store(env.DB);
    const requestId = "req_d1recency001" as OpaqueId;
    await store.createRequest({ requestId, username: "recency-user", nowMs: 100 });
    await store.startDiscovery(requestId, 110);
    expect(await store.completeDiscovery({
      requestId,
      githubAccountId: 9_001,
      canonicalLogin: "recency-user",
      repositories: [
        { repositoryId: 1, name: "stale", isFork: false, commitSha: "a".repeat(40), aiEligible: false },
        { repositoryId: 2, name: "active", isFork: false, commitSha: "b".repeat(40), aiEligible: true },
      ],
      nowMs: 120,
    })).toBe("completed");
    const page = await store.listRepositories({
      requestId,
      afterRepositoryId: null,
      limit: 10,
    });
    expect(page.repositories.map((row) => [row.repositoryId, row.aiEligible])).toEqual([
      [1, false],
      [2, true],
    ]);
    const claimed = await store.claimNextForWorker({
      workerId: "wrk_d1recency001",
      nowMs: 200,
      leaseDurationMs: 60_000,
    });
    expect(claimed).toMatchObject({ repositoryId: 1, aiEligible: false });
  });

  it("keeps null on a ledger written without the mark", async ({ expect }) => {
    const store = new D1Store(env.DB);
    const requestId = "req_d1nomark0001" as OpaqueId;
    await store.createRequest({ requestId, username: "nomark-user", nowMs: 100 });
    await store.startDiscovery(requestId, 110);
    expect(await store.completeDiscovery({
      requestId,
      githubAccountId: 9_002,
      canonicalLogin: "nomark-user",
      repositories: [
        { repositoryId: 1, name: "legacy", isFork: false, commitSha: "a".repeat(40) },
      ],
      nowMs: 120,
    })).toBe("completed");
    const page = await store.listRepositories({
      requestId,
      afterRepositoryId: null,
      limit: 10,
    });
    expect(page.repositories.map((row) => row.aiEligible)).toEqual([null]);
  });
});
