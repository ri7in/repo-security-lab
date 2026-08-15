import { describe, expect, it } from "vitest";
import { SPECIALISTS, SPECIALIST_PROGRESS_STATES } from "@app/contracts";
import { aggregateLedger, deriveRequestState } from "@app/core";
import { progress, repository, request } from "./helpers.js";

describe("request aggregation", () => {
  it("does not complete before discovery is finished", () => {
    expect(deriveRequestState(request("accepted", false), [])).toBe("accepted");
    expect(deriveRequestState(request("discovering", false), [])).toBe(
      "discovering",
    );
  });

  it("completes an empty account only after completed discovery", () => {
    expect(deriveRequestState(request("scanning", true), [])).toBe("complete");
  });

  it("requires every durable ledger row to be terminal", () => {
    const mixedTerminal = [
      repository(1, "complete"),
      repository(2, "empty"),
      repository(3, "partial"),
      repository(4, "failed"),
      repository(5, "cancelled"),
    ];
    expect(deriveRequestState(request(), mixedTerminal)).toBe("complete");
    expect(
      deriveRequestState(request(), [...mixedTerminal, repository(6, "waiting")]),
    ).toBe("scanning");
  });

  it("preserves request-level failure", () => {
    expect(deriveRequestState(request("failed"), [repository(1)])).toBe(
      "failed",
    );
  });

  it("returns exhaustive repository and coverage totals", () => {
    const first = { ...repository(1, "complete"), coverage: progress("complete") };
    const second = { ...repository(2, "waiting"), coverage: progress("waiting") };
    const result = aggregateLedger(request(), [first, second]);

    expect(result.requestState).toBe("scanning");
    expect(result.repositoryTotals.complete).toBe(1);
    expect(result.repositoryTotals.waiting).toBe(1);
    expect(Object.values(result.repositoryTotals).reduce((a, b) => a + b, 0)).toBe(2);

    for (const specialist of SPECIALISTS) {
      expect(result.coverageTotals[specialist].complete).toBe(1);
      expect(result.coverageTotals[specialist].waiting).toBe(1);
      expect(
        SPECIALIST_PROGRESS_STATES.reduce(
          (sum, state) => sum + result.coverageTotals[specialist][state],
          0,
        ),
      ).toBe(2);
    }
  });
});
