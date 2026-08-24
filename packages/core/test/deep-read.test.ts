import { describe, expect, it } from "vitest";
import { markDeepReadEligible, type DiscoveredRepository } from "@app/core";

function repo(
  repositoryId: number,
  overrides: Partial<DiscoveredRepository> = {},
): DiscoveredRepository {
  return {
    repositoryId,
    name: `repo-${String(repositoryId)}`,
    isFork: false,
    commitSha: "a".repeat(40),
    ...overrides,
  };
}

function winners(marked: readonly (DiscoveredRepository & { aiEligible: boolean })[]): number[] {
  return marked.filter((r) => r.aiEligible).map((r) => r.repositoryId);
}

describe("markDeepReadEligible", () => {
  it("awards the slots to the most recently pushed repositories", () => {
    const marked = markDeepReadEligible(
      [
        repo(1, { pushedAtMs: 100 }),
        repo(2, { pushedAtMs: 900 }),
        repo(3, { pushedAtMs: 500 }),
        repo(4, { pushedAtMs: 700 }),
      ],
      3,
    );
    expect(winners(marked).toSorted((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(marked.map((r) => r.repositoryId)).toEqual([1, 2, 3, 4]);
  });

  it("never awards a slot to a fork or an empty repository", () => {
    const marked = markDeepReadEligible(
      [
        repo(1, { pushedAtMs: 900, isFork: true }),
        repo(2, { pushedAtMs: 800, commitSha: null }),
        repo(3, { pushedAtMs: 10 }),
      ],
      3,
    );
    expect(winners(marked)).toEqual([3]);
  });

  it("ranks a repository with no push time behind every one with a time", () => {
    const marked = markDeepReadEligible(
      [repo(1, { pushedAtMs: null }), repo(2, { pushedAtMs: 5 }), repo(3)],
      2,
    );
    expect(winners(marked).toSorted((a, b) => a - b)).toEqual([2, 3]);
  });

  it("breaks ties, including all-unknown push times, by newest repository id", () => {
    const marked = markDeepReadEligible([repo(5), repo(9), repo(2)], 2);
    expect(winners(marked).toSorted((a, b) => a - b)).toEqual([5, 9]);
  });

  it("marks every repository explicitly even when candidates run short", () => {
    const marked = markDeepReadEligible(
      [repo(1, { isFork: true }), repo(2)],
      3,
    );
    expect(marked.map((r) => r.aiEligible)).toEqual([false, true]);
  });

  it("refuses a fractional or negative limit", () => {
    expect(() => markDeepReadEligible([repo(1)], -1)).toThrow();
    expect(() => markDeepReadEligible([repo(1)], 1.5)).toThrow();
  });
});
