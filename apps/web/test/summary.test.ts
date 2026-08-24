import { describe, expect, it } from "vitest";
import type { ScanRequestSummary } from "@app/contracts";
import {
  explainFailure,
  providerNames,
  percentDone,
  statusHeading,
  statusLine,
  summaryCards,
  terminalCount,
  totalCount,
} from "../src/summary.js";

/**
 * The cards above the ledger have been wrong twice, both times by counting
 * something a visitor would read as meaning something else.
 */

function summary(
  state: ScanRequestSummary["state"],
  totals: Record<string, number> = {},
  reason?: string,
): ScanRequestSummary {
  return {
    schemaVersion: 1,
    requestId: "req_0000000001",
    username: "ri7in",
    state,
    ...(reason === undefined ? {} : { reason }),
    repositoryTotals: {
      discovered: 0,
      waiting: 0,
      leased: 0,
      acquiring: 0,
      guarding: 0,
      scanning: 0,
      normalizing: 0,
      cleaning: 0,
      uploading: 0,
      waiting_to_publish: 0,
      complete: 0,
      empty: 0,
      partial: 0,
      failed: 0,
      cancelled: 0,
      ...totals,
    },
    coverageTotals: {},
    aiLane: "ai_not_run",
    retryAfterSeconds: 3,
    updatedAt: "2026-08-24T01:35:00.000Z",
  } as unknown as ScanRequestSummary;
}

describe("the summary cards", () => {
  it("counts the two scans separately", () => {
    // "Fully scanned" sat above a table where most rows read "Not reviewed".
    // The secret scan reaches every repository; the code review reaches three.
    const cards = summaryCards(
      summary("complete", { complete: 18, partial: 1, cancelled: 4 }),
      2,
      1,
      // From the rows' own coverage: the partly scanned repository's secret
      // scan did finish, and the card used to disagree with the ledger and the
      // PDF about that.
      19,
    );
    expect(cards.map((card) => [card.value, card.label])).toEqual([
      [23, "public repositories"],
      [19, "secret-scanned"],
      [2, "code-reviewed"],
      [1, "did not finish"],
      [1, "finding"],
    ]);
  });

  it("uses no word from the state machine", () => {
    const labels = summaryCards(summary("complete", { complete: 3 }), 0, 0, 3)
      .map((card) => card.label)
      .join(" ");
    expect(labels).not.toContain("terminal");
    // A deliberately skipped fork is not something the visitor must act on,
    // so it is not counted under anything that implies they should.
    expect(labels).not.toContain("attention");
    expect(labels).not.toContain("not fully checked");
  });

  it("counts the secret scan from coverage, not from repository state", () => {
    // A repository whose secret scan finished and whose AI review failed is
    // `partial`, so the state count left it out while the ledger row said
    // "Fully scanned" and the PDF said it had been examined.
    const cards = summaryCards(
      summary("complete", { complete: 4, partial: 1 }),
      0,
      0,
      5,
    );
    expect(cards[1]).toEqual({ value: 5, label: "secret-scanned" });
  });

  it("gets the singular right for one finding", () => {
    expect(summaryCards(summary("complete"), 0, 1, 0).at(-1)?.label).toBe("finding");
    expect(summaryCards(summary("complete"), 0, 0, 0).at(-1)?.label).toBe("findings");
    expect(summaryCards(summary("complete"), 0, 2, 0).at(-1)?.label).toBe("findings");
  });

  it("counts a skipped and a failed repository as finished, because they are", () => {
    const done = summary("complete", { complete: 20, cancelled: 2, failed: 1 });
    expect(terminalCount(done)).toBe(23);
    expect(totalCount(done)).toBe(23);
    expect(percentDone(done)).toBe(100);
  });

  it("never divides by zero on an account with no repositories", () => {
    expect(percentDone(summary("complete"))).toBe(100);
    expect(percentDone(summary("accepted"))).toBe(0);
  });
});

describe("the status line", () => {
  it("does not print a database enum at the visitor", () => {
    // "Request stopped: d1 write reserve." D1 is Cloudflare's database.
    expect(explainFailure("D1_WRITE_RESERVE")).not.toContain("d1 write reserve");
    expect(explainFailure("D1_WRITE_RESERVE").toLowerCase()).toContain(
      "free database allowance",
    );
  });

  it("does not repeat the reason the verdict banner already carries", () => {
    // Both printed the same sentence, word for word, one directly under the
    // other.
    const line = statusLine(summary("failed", { waiting: 3 }, "D1_WRITE_RESERVE"));
    expect(line).toBe("This scan stopped before it finished.");
  });

  it("says something useful for a code it has never seen", () => {
    const line = explainFailure("SOMETHING_NEW");
    expect(line).toContain("Try again");
    expect(line).not.toContain("SOMETHING_NEW");
    expect(explainFailure(undefined)).toBe(line);
  });

  it("reports progress while it is running and completion when it is done", () => {
    expect(statusLine(summary("scanning", { complete: 4, waiting: 6 }))).toBe(
      "4 of 10 repositories finished so far.",
    );
    expect(statusLine(summary("complete", { complete: 10 }))).toBe(
      "All 10 repositories finished.",
    );
    expect(statusLine(summary("complete", { complete: 1 }))).toBe(
      "All 1 repository finished.",
    );
  });

  it("does not say everything finished when some of it did not", () => {
    // "All 23 repositories finished." sat seventeen pixels under a verdict
    // reading "1 repository did not finish, so there may be more", and on a
    // larger account under "9 repositories did not finish".
    const line = statusLine(summary("complete", { complete: 22, failed: 1 }));
    expect(line).toBe("22 of 23 repositories finished.");
    expect(line).not.toContain("All ");
    expect(statusLine(summary("complete", { complete: 98, failed: 4, partial: 5 }))).toBe(
      "98 of 107 repositories finished.",
    );
  });

  it("still says all finished when all of them did", () => {
    // A fork is `cancelled`, which is a correct outcome and not a miss.
    expect(statusLine(summary("complete", { complete: 19, cancelled: 4 }))).toBe(
      "All 23 repositories finished.",
    );
  });

  it("does not count an empty account as a finished scan of nothing", () => {
    // "All 0 repositories finished." under a heading reading "Scan finished".
    const line = statusLine(summary("complete", {}));
    expect(line).toBe("This account has no public repositories to scan.");
    expect(line).not.toContain("0");
  });
});

describe("the heading over the result", () => {
  it("does not stay stale once the scan is done", () => {
    // "Coverage in progress" over a finished ledger made the numbers under it
    // look untrustworthy.
    expect(statusHeading(summary("scanning"))).toBe("Scan in progress");
    expect(statusHeading(summary("complete"))).toBe("Scan finished");
    expect(statusHeading(summary("failed"))).toBe("Scan stopped early");
  });

  it("uses no word from the design doctrine", () => {
    for (const state of ["scanning", "complete", "failed"] as const) {
      expect(statusHeading(summary(state)).toLowerCase()).not.toContain("coverage");
    }
  });
});

describe("explaining why a scan stopped", () => {
  it("explains every code the API can reject a request with", () => {
    // All six used to collapse into "something went wrong that this page
    // cannot explain, and the report id in the address bar is what to send
    // in", over a request that was never created and had no report id.
    for (const code of [
      "INVALID_USERNAME",
      "PRIVATE_SLICE_SCOPE",
      "DUPLICATE_ACTIVE_REQUEST",
      "RATE_LIMITED",
      "CAPACITY_EXHAUSTED",
      "EMAIL_UNAVAILABLE",
    ]) {
      const line = explainFailure(code);
      expect(line, `${code} is unexplained`).not.toContain("cannot explain");
      expect(line.length, `${code} is too thin`).toBeGreaterThan(40);
    }
  });

  it("does not point at a report id when no request was ever created", () => {
    // The single fallback told people to send in "the report id in the address
    // bar" over a POST that never got as far as creating one.
    const withReport = explainFailure("SOMETHING_NEW", true);
    const withoutReport = explainFailure("SOMETHING_NEW", false);
    expect(withReport).toContain("report id in the address bar");
    expect(withoutReport).not.toContain("report id");
    expect(withoutReport).toContain("could not be started");
  });

  it("still prefers a written explanation over either fallback", () => {
    expect(explainFailure("RATE_LIMITED", false)).toContain("Too many scans");
    expect(explainFailure("RATE_LIMITED", true)).toContain("Too many scans");
  });

  it("explains a stopped request in request terms, not repository terms", () => {
    // GITHUB_NOT_FOUND against a repository means it disappeared mid-scan.
    // Against a request it means the username does not exist, and the status
    // line was reading the repository wording.
    const line = explainFailure("GITHUB_NOT_FOUND");
    expect(line).toContain("no user account");
    expect(line).not.toContain("became private");
  });

  it("tells someone who typed an organisation what is wrong", () => {
    expect(explainFailure("GITHUB_NOT_FOUND")).toContain("organisation");
  });
});

describe("naming the model providers", () => {
  it("writes them the way a person would", () => {
    // The footer sentence that tells people where their code goes read
    // "openrouter and groq and gemini".
    expect(providerNames(["openrouter", "groq", "gemini"])).toBe(
      "OpenRouter, Groq and Google",
    );
  });

  it("handles one and two without a stray comma", () => {
    expect(providerNames(["groq"])).toBe("Groq");
    expect(providerNames(["openrouter", "groq"])).toBe("OpenRouter and Groq");
  });

  it("says something rather than nothing when the list is empty", () => {
    expect(providerNames([])).toBe("an external model provider");
  });

  it("passes through a provider it has no name for", () => {
    // Better an unfamiliar id in the disclosure than a provider left out of it.
    expect(providerNames(["openrouter", "somebody-new"])).toBe(
      "OpenRouter and somebody-new",
    );
  });
});
