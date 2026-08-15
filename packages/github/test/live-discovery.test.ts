import { expect, it } from "vitest";
import { GithubDiscoveryClient } from "@app/github";

const liveTest = process.env["RUN_LIVE_GITHUB"] === "1" ? it : it.skip;

liveTest("discovers the operator-owned public ledger read-only", async () => {
  const token = process.env["GH_TOKEN"];
  if (token === undefined || token.length === 0) {
    throw new Error("live GitHub token missing");
  }
  const startedAt = Date.now();
  const result = await new GithubDiscoveryClient({ token }).discover("ri7in");
  const repositories = result.account.repositories;
  const summary = {
    mode: result.mode,
    requestCount: result.requestCount,
    repositoryCount: repositories.length,
    forkCount: repositories.filter((repository) => repository.isFork).length,
    emptyCount: repositories.filter(
      (repository) => repository.commitSha === null,
    ).length,
    elapsedMs: Date.now() - startedAt,
  };

  console.info("live discovery summary", summary);
  expect(result.mode).toBe("authenticated_graphql");
  expect(result.account.canonicalLogin.toLowerCase()).toBe("ri7in");
  expect(repositories.length).toBeGreaterThan(0);
  expect(repositories.every((repository) => Number.isSafeInteger(repository.repositoryId))).toBe(true);
  expect(repositories.every((repository) => repository.name.length > 0)).toBe(true);
});
