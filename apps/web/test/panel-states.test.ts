import { describe, expect, it } from "vitest";
import { couldNotStart, lostContact, reportNotFound } from "../src/panel-states.js";

/**
 * Three situations reach the panel with no summary behind it, and all three
 * were written out by hand at their call sites. Two forgot the heading, so the
 * page read "Scan in progress" directly above the words "Scan stopped" while
 * step one pulsed forever.
 */

const STATES = [
  ["report not found", reportNotFound()],
  ["lost contact", lostContact()],
  ["could not start", couldNotStart("GitHub has no user account with that name.")],
] as const;

describe("the states with no summary behind them", () => {
  it("every one replaces the heading", () => {
    for (const [name, state] of STATES) {
      expect(state.heading, `${name} has no heading`).not.toBe("");
      expect(state.heading.toLowerCase()).not.toContain("in progress");
    }
  });

  it("every one says something a person can act on", () => {
    for (const [name, state] of STATES) {
      expect(state.status.length, `${name} says too little`).toBeGreaterThan(30);
      expect(state.detail.length, `${name} has no detail`).toBeGreaterThan(10);
      expect(state.announcement.length, `${name} announces nothing`).toBeGreaterThan(10);
    }
  });

  it("does not call a service outage a missing report", () => {
    // Replacing a fully populated ledger with "that report link is not valid"
    // was the worst thing this page did on a hiccup.
    expect(lostContact().status).not.toContain("not valid");
    expect(lostContact().status).toContain("already shown below is real");
    expect(reportNotFound().status).toContain("30 day expiry");
  });

  it("only offers a verdict where there is something to say", () => {
    // A report that does not exist has no verdict. A scan that could not start
    // does: the reason it could not.
    expect(reportNotFound().verdict).toBeNull();
    expect(lostContact().verdict).toBeNull();
    expect(couldNotStart("Because.").verdict).toContain("Because.");
  });

  it("carries the reason through rather than restating it", () => {
    const why = "GitHub is rate limiting this service right now.";
    const state = couldNotStart(why);
    expect(state.status).toContain(why);
    expect(state.detail).toBe(why);
    expect(state.announcement).toContain(why);
  });
});
