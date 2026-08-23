import { describe, expect, it } from "vitest";
import { SPECIALISTS } from "@app/contracts";
import { validatePublishInput, type PublishInput } from "../src/index.js";

/**
 * This function stopped a whole request dead for an hour.
 *
 * The AI engine set its coverage to failed without attaching a reason, which
 * this refuses, and a refused publication keeps its lease, which the worker
 * will not claim past. Nothing tested the refusals themselves.
 */

function coverage(
  overrides: Partial<Record<string, string>> = {},
): PublishInput["coverage"] {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [
      specialist,
      overrides[specialist] ?? "not_applicable",
    ]),
  ) as PublishInput["coverage"];
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    requestId: "req_00000001",
    repositoryId: 7,
    workerId: "worker_00000001",
    generation: 1,
    nowMs: 1_000,
    terminalState: "complete",
    reason: null,
    coverage: coverage({ snapshot: "complete", archive_guard: "complete", gitleaks: "complete" }),
    specialistReasons: {},
    findings: [],
    ...overrides,
  } as PublishInput;
}

describe("refusing a publication", () => {
  it("accepts the ordinary complete case", () => {
    expect(() => {
      validatePublishInput(input());
    }).not.toThrow();
  });

  it("refuses a generation of zero, which is not a lease", () => {
    expect(() => {
      validatePublishInput(input({ generation: 0 }));
    }).toThrow("invalid publication metadata");
  });

  it("refuses a negative or fractional clock", () => {
    for (const nowMs of [-1, 1.5, Number.NaN]) {
      expect(() => {
        validatePublishInput(input({ nowMs }));
      }, String(nowMs)).toThrow("invalid publication metadata");
    }
  });

  it("refuses an identifier that is not one", () => {
    expect(() => {
      validatePublishInput(input({ requestId: "no spaces allowed" }));
    }).toThrow("invalid publication metadata");
    expect(() => {
      validatePublishInput(input({ repositoryId: -1 }));
    }).toThrow("invalid publication metadata");
  });

  it("refuses a coverage value outside the vocabulary", () => {
    expect(() => {
      // Shaped to pass every structural rule so that only the per-specialist
      // vocabulary check can reject it.
      validatePublishInput(
        input({
          coverage: coverage({ snapshot: "nearly", gitleaks: "failed" }),
          terminalState: "failed",
          reason: "SCANNER_INTERNAL",
          specialistReasons: { gitleaks: "SCANNER_INTERNAL" },
        }),
      );
    }).toThrow("invalid publication coverage");
  });

  it("refuses a failed engine with no reason attached", () => {
    // This is the exact shape that stalled the queue: the reader set the AI
    // engine to failed and nothing said why.
    expect(() => {
      validatePublishInput(
        input({
          coverage: coverage({
            snapshot: "complete",
            archive_guard: "complete",
            gitleaks: "complete",
            ai: "failed",
          }),
          terminalState: "partial",
          reason: "FINDING_LIMIT",
        }),
      );
    }).toThrow("invalid publication metadata");
  });

  it("accepts the same shape once the reason is attached", () => {
    expect(() => {
      validatePublishInput(
        input({
          coverage: coverage({
            snapshot: "complete",
            archive_guard: "complete",
            gitleaks: "complete",
            ai: "failed",
          }),
          terminalState: "partial",
          reason: "SCANNER_INTERNAL",
          specialistReasons: { ai: "SCANNER_INTERNAL" },
        }),
      );
    }).not.toThrow();
  });

  it("refuses a complete publication that carries a reason", () => {
    expect(() => {
      validatePublishInput(input({ reason: "SCANNER_INTERNAL" }));
    }).toThrow("invalid publication metadata");
  });

  it("refuses findings on a failed or cancelled publication", () => {
    // Nothing was scanned, so nothing may be reported.
    for (const terminalState of ["failed", "cancelled"] as const) {
      expect(() => {
        validatePublishInput(
          input({
            terminalState,
            reason: terminalState === "cancelled" ? "CANCELLED" : "SCANNER_INTERNAL",
            coverage: coverage({ gitleaks: "failed" }),
            specialistReasons: { gitleaks: "SCANNER_INTERNAL" },
            findings: [{ finding_id: "f_1" }] as unknown as PublishInput["findings"],
          }),
        );
      }, terminalState).toThrow();
    }
  });

  it("refuses more findings than the chunk store can hold", () => {
    expect(() => {
      validatePublishInput(
        input({
          findings: Array.from({ length: 1_025 }, (_, index) => ({
            finding_id: `f_${String(index)}`,
          })) as unknown as PublishInput["findings"],
        }),
      );
    }).toThrow("invalid publication findings");
  });

  it("refuses a cancelled publication that claims a check ran", () => {
    expect(() => {
      validatePublishInput(
        input({
          terminalState: "cancelled",
          reason: "CANCELLED",
          coverage: coverage({ gitleaks: "complete" }),
        }),
      );
    }).toThrow("invalid publication metadata");
  });
});
