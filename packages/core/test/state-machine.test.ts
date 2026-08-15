import { describe, expect, it } from "vitest";
import {
  REPOSITORY_STATES,
  REPOSITORY_TERMINAL_STATES,
  type RepositoryState,
} from "@app/contracts";
import {
  REPOSITORY_TRANSITIONS,
  assertCompleteStateGraph,
  canRequeueExpiredLease,
  canTransition,
} from "@app/core";

const expectedEdges = new Set([
  "discovered:waiting",
  "discovered:empty",
  "discovered:failed",
  "discovered:cancelled",
  "waiting:leased",
  "waiting:cancelled",
  "leased:acquiring",
  "leased:cancelled",
  "acquiring:guarding",
  "acquiring:cleaning",
  "guarding:scanning",
  "guarding:cleaning",
  "scanning:normalizing",
  "scanning:cleaning",
  "normalizing:cleaning",
  "cleaning:uploading",
  "cleaning:partial",
  "cleaning:failed",
  "cleaning:cancelled",
  "uploading:waiting_to_publish",
  "uploading:partial",
  "uploading:failed",
  "uploading:cancelled",
  "waiting_to_publish:complete",
  "waiting_to_publish:partial",
  "waiting_to_publish:failed",
  "waiting_to_publish:cancelled",
]);

describe("repository state graph", () => {
  it("enumerates every state and every accepted legal edge", () => {
    expect(Object.keys(REPOSITORY_TRANSITIONS).sort()).toEqual(
      [...REPOSITORY_STATES].sort(),
    );
    for (const from of REPOSITORY_STATES) {
      for (const to of REPOSITORY_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          expectedEdges.has(`${from}:${to}`),
        );
      }
    }
    expect(() => assertCompleteStateGraph()).not.toThrow();
  });

  it("makes terminal states absorbing", () => {
    for (const state of REPOSITORY_TERMINAL_STATES) {
      expect(REPOSITORY_TRANSITIONS[state]).toEqual([]);
    }
  });

  it("forces acquired source through cleaning before a terminal outcome", () => {
    for (const state of ["acquiring", "guarding", "scanning", "normalizing"] satisfies RepositoryState[]) {
      expect(canTransition(state, "failed")).toBe(false);
      expect(canTransition(state, "partial")).toBe(false);
      expect(canTransition(state, "cleaning")).toBe(true);
    }
  });

  it("treats expiry requeue as a separate recovery operation", () => {
    for (const state of REPOSITORY_STATES) {
      const expected = [
        "leased",
        "acquiring",
        "guarding",
        "scanning",
        "normalizing",
        "cleaning",
        "uploading",
        "waiting_to_publish",
      ].includes(state);
      expect(canRequeueExpiredLease(state), state).toBe(expected);
    }
  });
});
