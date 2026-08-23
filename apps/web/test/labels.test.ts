import { describe, expect, it } from "vitest";
import { aiCoverageLabel, coverageLabel, repositoryLabel } from "../src/labels.js";
import { FAILURE_CLASSES } from "@app/contracts";

/**
 * The label layer is where internal vocabulary becomes something a visitor can
 * read, so the assertions here are about meaning rather than wording: a
 * deliberate skip must never wear the colour of a failure, and a check with
 * nothing to do must read as clean.
 */

describe("repository labels", () => {
  it("says a fork was not checked, and why", () => {
    // The stored reason is PRIVATE_SLICE_SCOPE, left over from when the tool
    // ran against an allowlist. On the public service a fork is the only thing
    // that triggers it, and "PRIVATE SLICE SCOPE" tells a visitor nothing.
    const label = repositoryLabel("cancelled", "PRIVATE_SLICE_SCOPE");
    // A fork skipped on purpose and a repository skipped for being too large
    // are different news, and both used to wear the identical chip.
    expect(label.text).toBe("Fork, skipped");
    expect(label.tone).toBe("skipped");
    expect(label.detail.toLowerCase()).toContain("fork");
  });

  it("does not colour a deliberate skip as a failure", () => {
    for (const reason of ["PRIVATE_SLICE_SCOPE", "ARCHIVE_LIMIT", "GITHUB_NOT_FOUND"]) {
      expect(repositoryLabel("cancelled", reason).tone).not.toBe("problem");
    }
  });

  it("does colour a genuine failure as a failure", () => {
    for (const reason of ["SCANNER_INTERNAL", "ARCHIVE_UNSAFE", "GITHUB_RATE_LIMIT"]) {
      expect(repositoryLabel("failed", reason).tone).toBe("problem");
    }
  });

  it("says a size refusal is temporary, not a verdict", () => {
    const label = repositoryLabel("failed", "ARCHIVE_LIMIT");
    expect(label.text).toBe("Too big");
    expect(label.detail).toContain("250 MB");
    // It must not read as "checked and fine", and it must not promise a
    // re-check that nothing in this system ever performs.
    expect(label.detail.toLowerCase()).toContain("free tier");
    expect(label.detail.toLowerCase()).not.toContain("will be checked");
  });

  it("does not headline a partly scanned repository with the check that worked", () => {
    // A repository whose secret scan came back clean and whose AI review
    // failed was headlined "Scanner error", blaming the check that worked.
    // The per-engine columns already say which one it was.
    const label = repositoryLabel("partial", "SCANNER_INTERNAL");
    expect(label.text).toBe("Partly scanned");
    expect(label.detail).toContain("columns to the right");
    // The specific reason is still reachable, just not as the headline.
    expect(label.detail.toLowerCase()).toContain("scanner");
  });

  it("still lets the reason headline a failed or cancelled repository", () => {
    // There, "failed" on its own tells a visitor nothing they can act on.
    expect(repositoryLabel("failed", "ARCHIVE_LIMIT").text).toBe("Too big");
    expect(repositoryLabel("cancelled", "PRIVATE_SLICE_SCOPE").text).toBe("Fork, skipped");
  });

  it("marks a finished repository as scanned", () => {
    const label = repositoryLabel("complete");
    expect(label.tone).toBe("ok");
    expect(label.text).toBe("Scanned");
  });

  it("does not claim every applicable check ran", () => {
    // A repository publishes complete while three engines report unsupported,
    // which labels.ts itself defines as "there is relevant code here, but this
    // check is not switched on yet". Sixteen rows of a live report said both.
    const detail = repositoryLabel("complete").detail.toLowerCase();
    expect(detail).not.toContain("every check that applies");
    expect(detail).toContain("not switched on yet");
  });

  it("treats in-flight states as active, never as failures", () => {
    for (const state of ["waiting", "acquiring", "guarding", "scanning", "uploading"]) {
      expect(repositoryLabel(state).tone).toBe("active");
    }
  });

  it("gives every failure class a written explanation", () => {
    // A class with no entry falls through to "Unknown", which is a bug rather
    // than a label. This catches a new class being added upstream and never
    // being described here.
    for (const reason of FAILURE_CLASSES) {
      const label = repositoryLabel("failed", reason);
      expect(label.text, `${reason} has no label`).not.toBe("Unknown");
      expect(label.detail.length, `${reason} has no explanation`).toBeGreaterThan(20);
    }
  });
});

describe("coverage labels", () => {
  it("never paints an unread repository green", () => {
    // On the live service this outcome is reached only by a repository that
    // was skipped before a single file was downloaded, and it used to read
    // "Nothing to check" in the same green as a repository that really was
    // scanned and really was clean.
    const label = coverageLabel("not_applicable");
    expect(label.tone).toBe("skipped");
    // "not applicable" read as a fault to every visitor who saw it.
    expect(label.text).not.toContain("applicable");
    expect(label.text).toBe("Not scanned");
  });

  it("does not state a verdict where it only knows the check ran", () => {
    // "Clear" put a clean verdict in the row of a repository whose leaked key
    // was listed two hundred pixels further down the same page.
    const label = coverageLabel("complete");
    expect(label.tone).toBe("ok");
    expect(label.text).toBe("Fully scanned");
    expect(label.text.toLowerCase()).not.toContain("clear");
  });

  it("lets a specific reason override the generic coverage state", () => {
    expect(coverageLabel("failed", "ARCHIVE_LIMIT").text).toBe("Too big");
  });
});

describe("AI review labels", () => {
  it("says a repository was reviewed when a model actually read it", () => {
    // The column used to read a request-level field that never left
    // "ai_not_run", so a repository a model had genuinely read still said the
    // review had not run.
    const label = aiCoverageLabel("complete");
    expect(label.tone).toBe("ok");
    expect(label.text).toBe("Reviewed");
  });

  it("does not present a repository that was not reviewed as a failure", () => {
    // The daily budget running out is the expected case, not a fault.
    expect(aiCoverageLabel("unsupported").tone).toBe("skipped");
  });

  it("never paints an unreviewed repository green", () => {
    // Forks reach not_applicable, and they are substantial repositories that
    // simply were not downloaded. "No code to read" was false about them, in
    // the colour that means fine.
    expect(aiCoverageLabel("not_applicable").tone).toBe("skipped");
    expect(aiCoverageLabel("unsupported").tone).toBe("skipped");
    expect(aiCoverageLabel("failed").tone).toBe("problem");
  });

  it("does not invent a cause it was never told", () => {
    // It used to assert the model provider was unreachable, which the stored
    // reason often contradicted. Inventing a rationale on a security page is
    // worse than saying less.
    const detail = aiCoverageLabel("failed").detail.toLowerCase();
    expect(detail).not.toContain("could not be reached");
    expect(detail).toContain("status column");
  });

  it("does not claim a selection rule the queue does not follow", () => {
    // Repositories are claimed in repository id order, so "the most recently
    // updated" was falsifiable from the ledger on the same page.
    const detail = aiCoverageLabel("unsupported").detail.toLowerCase();
    expect(detail).not.toContain("recently updated");
    // And the budget is per worker run, not per scan: it is an instance field
    // on the worker that is never reset between requests, so a run serving two
    // visitors at once splits three reads between them.
    expect(detail).toContain("3 repositories per worker run");
    expect(detail).not.toContain("per scan get");
  });

  it("flags a half-finished review, because the result is incomplete", () => {
    expect(aiCoverageLabel("partial").tone).toBe("problem");
  });

  it("explains every outcome the coverage vocabulary can produce", () => {
    for (const outcome of [
      "complete",
      "partial",
      "not_applicable",
      "unsupported",
      "failed",
      "waiting",
    ]) {
      const label = aiCoverageLabel(outcome);
      expect(label.text, `${outcome} has no label`).not.toBe("Unknown");
      expect(label.detail.length, `${outcome} has no explanation`).toBeGreaterThan(20);
    }
  });

  it("falls back rather than throwing on an unknown state", () => {
    expect(aiCoverageLabel("something_new").text).toBe("Unknown");
  });
});
