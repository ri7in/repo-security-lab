import { describe, expect, it } from "vitest";
import { aiLaneLabel, coverageLabel, repositoryLabel } from "../src/labels.js";
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
    expect(label.text).toBe("Not checked");
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
    expect(label.text).toBe("Not checked");
    expect(label.detail).toContain("250 MB");
    // "Not checked" must not read as "checked and fine".
    expect(label.detail.toLowerCase()).toContain("free compute");
  });

  it("marks a finished repository as scanned", () => {
    const label = repositoryLabel("complete");
    expect(label.tone).toBe("ok");
    expect(label.text).toBe("Scanned");
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
  it("reads nothing-to-check as a clean result", () => {
    const label = coverageLabel("not_applicable");
    expect(label.tone).toBe("ok");
    // "not applicable" read as a fault to every visitor who saw it.
    expect(label.text).not.toContain("applicable");
  });

  it("separates not-yet-covered from nothing-to-check", () => {
    expect(coverageLabel("unsupported").tone).toBe("skipped");
    expect(coverageLabel("not_applicable").tone).toBe("ok");
  });

  it("lets a specific reason override the generic coverage state", () => {
    expect(coverageLabel("failed", "ARCHIVE_LIMIT").text).toBe("Not checked");
  });
});

describe("AI lane labels", () => {
  it("does not present a not-run review as a failure", () => {
    expect(aiLaneLabel("ai_not_run").tone).toBe("skipped");
  });

  it("flags a half-finished review, because the result is incomplete", () => {
    expect(aiLaneLabel("ai_partial").tone).toBe("problem");
  });

  it("marks a finished review as clean", () => {
    expect(aiLaneLabel("ai_complete").tone).toBe("ok");
  });

  it("falls back rather than throwing on an unknown state", () => {
    expect(aiLaneLabel("something_new").text).toBe("Unknown");
  });
});
