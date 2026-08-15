import { describe, expect, it } from "vitest";
import {
  REPOSITORY_ACTIVE_STATES,
  REPOSITORY_STATES,
  REPOSITORY_TERMINAL_STATES,
  SCAN_REQUEST_STATES,
  isTerminalRepositoryState,
  repositoryStateSchema,
  scanRequestStateSchema,
} from "@app/contracts";

describe("repository states", () => {
  it("matches the accepted state machine vocabulary exactly", () => {
    expect(REPOSITORY_ACTIVE_STATES).toEqual([
      "discovered",
      "waiting",
      "leased",
      "acquiring",
      "guarding",
      "scanning",
      "normalizing",
      "cleaning",
      "uploading",
      "waiting_to_publish",
    ]);
    expect(REPOSITORY_TERMINAL_STATES).toEqual([
      "complete",
      "empty",
      "partial",
      "failed",
      "cancelled",
    ]);
    expect(REPOSITORY_STATES).toHaveLength(15);
  });

  it("accepts every declared state and rejects unknown states", () => {
    for (const state of REPOSITORY_STATES) {
      expect(repositoryStateSchema.safeParse(state).success).toBe(true);
    }
    for (const bad of ["", "done", "COMPLETE", "skipped", 1, null, undefined]) {
      expect(repositoryStateSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("classifies terminal states correctly", () => {
    for (const state of REPOSITORY_TERMINAL_STATES) {
      expect(isTerminalRepositoryState(state)).toBe(true);
    }
    for (const state of REPOSITORY_ACTIVE_STATES) {
      expect(isTerminalRepositoryState(state)).toBe(false);
    }
  });
});

describe("scan request states", () => {
  it("is a closed vocabulary", () => {
    expect(SCAN_REQUEST_STATES).toEqual([
      "accepted",
      "discovering",
      "scanning",
      "complete",
      "failed",
    ]);
    expect(scanRequestStateSchema.safeParse("partial").success).toBe(false);
    expect(scanRequestStateSchema.safeParse("accepted").success).toBe(true);
  });
});
