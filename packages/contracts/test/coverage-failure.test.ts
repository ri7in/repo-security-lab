import { describe, expect, it } from "vitest";
import {
  AI_LANE_STATES,
  FAILURE_CLASSES,
  SCAN_ENGINES,
  SPECIALISTS,
  SPECIALIST_COVERAGE_OUTCOMES,
  SPECIALIST_PROGRESS_STATES,
  aiLaneStateSchema,
  failureClassSchema,
  scanEngineSchema,
  specialistCoverageOutcomeSchema,
  specialistProgressStateSchema,
  specialistSchema,
} from "@app/contracts";

describe("engines and specialists", () => {
  it("declares exactly the four deterministic engines", () => {
    expect(SCAN_ENGINES).toEqual(["gitleaks", "osv", "zizmor", "opengrep"]);
    expect(scanEngineSchema.safeParse("gitleaks").success).toBe(true);
    expect(scanEngineSchema.safeParse("trivy").success).toBe(false);
  });

  it("includes snapshot and archive_guard as coverage-bearing specialists", () => {
    expect(SPECIALISTS).toEqual([
      "snapshot",
      "archive_guard",
      "gitleaks",
      "osv",
      "zizmor",
      "opengrep",
    ]);
    expect(specialistSchema.safeParse("archive_guard").success).toBe(true);
    expect(specialistSchema.safeParse("normalizer").success).toBe(false);
  });
});

describe("coverage vocabulary", () => {
  it("keeps coverage outcomes to exactly the accepted five", () => {
    expect(SPECIALIST_COVERAGE_OUTCOMES).toEqual([
      "complete",
      "not_applicable",
      "unsupported",
      "partial",
      "failed",
    ]);
    // `waiting` is a progress state, never a coverage outcome.
    expect(specialistCoverageOutcomeSchema.safeParse("waiting").success).toBe(
      false,
    );
    expect(specialistCoverageOutcomeSchema.safeParse("skipped").success).toBe(
      false,
    );
  });

  it("progress states add only waiting on top of the outcomes", () => {
    expect(SPECIALIST_PROGRESS_STATES).toEqual([
      "waiting",
      ...SPECIALIST_COVERAGE_OUTCOMES,
    ]);
    expect(specialistProgressStateSchema.safeParse("waiting").success).toBe(
      true,
    );
    expect(specialistProgressStateSchema.safeParse("skipped").success).toBe(
      false,
    );
  });

  it("keeps the AI lane vocabulary closed and honest", () => {
    expect(AI_LANE_STATES).toEqual(["ai_not_run", "ai_waiting", "ai_partial"]);
    // No state may claim completed AI review in this slice.
    expect(aiLaneStateSchema.safeParse("ai_complete").success).toBe(false);
  });
});

describe("failure classes", () => {
  it("contains the accepted classes plus PRIVATE_SLICE_SCOPE", () => {
    expect(FAILURE_CLASSES).toContain("PRIVATE_SLICE_SCOPE");
    expect(FAILURE_CLASSES).toContain("FINDING_LIMIT");
    expect(FAILURE_CLASSES).toContain("SOURCE_CLEANUP_FAILED");
    expect(FAILURE_CLASSES).toContain("LEASE_RETRY_EXHAUSTED");
    expect(FAILURE_CLASSES).toHaveLength(21);
  });

  it("uses only fixed UPPER_SNAKE identifiers", () => {
    for (const failureClass of FAILURE_CLASSES) {
      expect(failureClass).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
    expect(new Set(FAILURE_CLASSES).size).toBe(FAILURE_CLASSES.length);
  });

  it("rejects free-form failure text", () => {
    expect(failureClassSchema.safeParse("scanner exploded: /tmp/x").success).toBe(
      false,
    );
    expect(failureClassSchema.safeParse("PRIVATE_SLICE_SCOPE").success).toBe(
      true,
    );
  });
});
