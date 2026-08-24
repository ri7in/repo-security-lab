import { describe, expect, it } from "vitest";
import type { ScanRequestSummary } from "@app/contracts";
import {
  explainFailure,
  printCoverText,
  providerNames,
  runOutcome,
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

  it("agrees with its own count on a one repository account", () => {
    // "0 of 1 repositories finished." was on screen for the whole scan, and
    // the return directly below the patched one has carried the singular
    // since it was written.
    expect(statusLine(summary("complete", { failed: 1 }))).toBe(
      "0 of 1 repository finished.",
    );
    expect(statusLine(summary("scanning", { waiting: 1 }))).toBe(
      "0 of 1 repository finished so far.",
    );
    // The plural keys off the total, not the leading count, so this stays right.
    expect(statusLine(summary("scanning", { complete: 1, waiting: 1 }))).toBe(
      "1 of 2 repositories finished so far.",
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
    // Not "could not be started": couldNotStart already prefixes "This scan
    // could not start", and having both produced that sentence twice in one
    // banner. This half carries only what the reader can act on.
    expect(withoutReport).toContain("Check your connection");
    expect(withoutReport).not.toMatch(/could not (start|be started)/);
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

describe("the count on a summary card", () => {
  it("gets the singular right for one public repository", () => {
    // "1" sat over "public repositories" three lines above a status line this
    // same change corrected to "0 of 1 repository finished.", and the findings
    // card in the same function has branched on its own count since it was
    // written.
    expect(summaryCards(summary("complete", { complete: 1 }), 1, 0, 1)[0]?.label).toBe(
      "public repository",
    );
    expect(summaryCards(summary("complete", { complete: 2 }), 2, 0, 2)[0]?.label).toBe(
      "public repositories",
    );
  });
});

describe("the line at the top of a printed page", () => {
  const when = "24/08/2026, 01:35";

  it("does not say nothing found over a scan that read no repository", () => {
    // A request reaches `complete` as soon as every repository is terminal,
    // and `failed` is terminal, so four failed repositories printed "4 public
    // repositories in the account, nothing found" directly above the verdict
    // "No repository here was read, so this scan has no result."
    const line = printCoverText(summary("complete", { failed: 4 }), 0, 0, when);
    expect(line).toContain("No repository here was read");
    expect(line).not.toContain("nothing found");
    expect(line).not.toContain("in the account");
  });

  it("does not deny a result over a findings table with rows in it", () => {
    // A repository whose secret scan hit the finding limit is `partial` and
    // still publishes what it found, so nothing was read in full while twelve
    // findings print directly under this line. Denying a result there is worse
    // than the false all-clear this whole change is about.
    const line = printCoverText(summary("complete", { partial: 1 }), 0, 12, when);
    expect(line).toBe(
      `1 public repository in the account · 12 findings · scanned ${when}`,
    );
  });

  it("does not claim a result while the scan is still running", () => {
    // .print-cover has an unconditional display block inside @media print, so
    // Cmd+P halfway through a scan printed "11 public repositories in the
    // account, nothing found" over a status section reading "Scan in progress"
    // and "5 of 11 repositories finished so far".
    const line = printCoverText(
      summary("scanning", { complete: 5, scanning: 6 }),
      5,
      0,
      when,
    );
    expect(line).toContain("5 of 11 repositories finished so far");
    expect(line).not.toContain("nothing found");
  });

  it("tells an empty account there was nothing to scan", () => {
    const line = printCoverText(summary("complete"), 0, 0, when);
    expect(line).toContain("no public repositories");
    expect(line).not.toContain("nothing found");
  });

  it("keeps the count and the result once something really was read", () => {
    expect(printCoverText(summary("complete", { complete: 3 }), 3, 0, when)).toBe(
      `3 public repositories in the account · nothing found · scanned ${when}`,
    );
    expect(printCoverText(summary("complete", { complete: 1 }), 1, 2, when)).toBe(
      `1 public repository in the account · 2 findings · scanned ${when}`,
    );
  });

  it("still says a stopped request has no result", () => {
    const line = printCoverText(summary("failed", {}, "GITHUB_NETWORK"), 0, 0, when);
    expect(line).toContain("stopped before it finished");
    expect(line).not.toContain("nothing found");
  });
});

describe("whether a finished run may wear the finished colour", () => {
  it("separates having stopped from having worked", () => {
    const allFailed = summary("complete", { failed: 4 });
    // Both are true at once, and reading the second off the first is what put
    // a full green bar between "0 of 4 repositories finished." and a red
    // verdict saying no repository here was read.
    expect(percentDone(allFailed)).toBe(100);
    expect(runOutcome(allFailed)).toBe("incomplete");
  });

  it("keeps the green when a fork was the only thing skipped", () => {
    expect(runOutcome(summary("complete", { complete: 9, cancelled: 2 }))).toBe("done");
    expect(runOutcome(summary("complete", { complete: 9, empty: 1 }))).toBe("done");
  });

  it("names a partly scanned repository as a gap", () => {
    expect(runOutcome(summary("complete", { complete: 9, partial: 1 }))).toBe(
      "incomplete",
    );
  });

  it("keeps a stopped request red and a live one amber", () => {
    expect(runOutcome(summary("failed", { complete: 3 }))).toBe("failed");
    expect(runOutcome(summary("scanning", { waiting: 3 }))).toBe("running");
  });
});
