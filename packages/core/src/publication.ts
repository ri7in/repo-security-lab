import {
  SCAN_ENGINES,
  SPECIALISTS,
  brokerDerivedFindingSchema,
  failureClassSchema,
  opaqueIdSchema,
  specialistCoverageOutcomeSchema,
} from "@app/contracts";
import type { PublishInput } from "./domain.js";

function safeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Shared fail-closed validation used by every durable Store adapter. */
export function validatePublishInput(input: PublishInput): void {
  if (
    !opaqueIdSchema.safeParse(input.requestId).success ||
    !opaqueIdSchema.safeParse(input.workerId).success ||
    !safeNonNegativeInteger(input.repositoryId) ||
    !safeNonNegativeInteger(input.generation) ||
    input.generation === 0 ||
    !safeNonNegativeInteger(input.nowMs)
  ) {
    throw new Error("invalid publication metadata");
  }
  const coverageValues = SPECIALISTS.map(
    (specialist) => input.coverage[specialist],
  );
  const successfulEngines = SCAN_ENGINES.filter((engine) =>
    ["complete", "partial"].includes(input.coverage[engine]),
  );
  const failedEngines = SCAN_ENGINES.filter(
    (engine) => input.coverage[engine] === "failed",
  );
  const partialEngines = SCAN_ENGINES.filter(
    (engine) => input.coverage[engine] === "partial",
  );
  const baseFailed =
    input.coverage.snapshot === "failed" ||
    input.coverage.archive_guard === "failed";
  const reasonEntries = Object.entries(input.specialistReasons);
  const reasonsMatchFailedEngines = reasonEntries.every(
    ([engine, reason]) =>
      SCAN_ENGINES.includes(engine as (typeof SCAN_ENGINES)[number]) &&
      input.coverage[engine as (typeof SCAN_ENGINES)[number]] === "failed" &&
      failureClassSchema.safeParse(reason).success,
  );
  const allFailedEnginesAttributed = failedEngines.every(
    (engine) => input.specialistReasons[engine] !== undefined,
  );
  const firstFailedReason = failedEngines
    .map((engine) => input.specialistReasons[engine])
    .find((reason) => reason !== undefined);
  if (
    !["complete", "partial", "failed", "cancelled"].includes(
      input.terminalState,
    ) ||
    (input.terminalState === "complete" && input.reason !== null) ||
    // Partial is the one non-complete state allowed a null reason. The domain
    // contract says so in as many words: there is no class in the closed enum
    // that means "one engine covered part of this", and the worker's fallback
    // to FINDING_LIMIT printed a cap explanation over repositories that never
    // hit a cap. This validator kept demanding one anyway, so the first live
    // repository whose AI read was partial had its real result refused as
    // INVALID_BODY and was published as a bare failure instead.
    (input.terminalState === "failed" && input.reason === null) ||
    (input.terminalState === "cancelled" && input.reason === null) ||
    (input.reason !== null &&
      !failureClassSchema.safeParse(input.reason).success) ||
    (input.terminalState === "complete" &&
      (coverageValues.some(
        (outcome) => outcome === "partial" || outcome === "failed",
      ) ||
        reasonEntries.length > 0)) ||
    (input.terminalState === "partial" &&
      (baseFailed ||
        successfulEngines.length === 0 ||
        (partialEngines.length === 0 && failedEngines.length === 0) ||
        (failedEngines.length > 0
          ? !allFailedEnginesAttributed || input.reason !== firstFailedReason
          : (input.reason !== null && input.reason !== "FINDING_LIMIT") ||
            reasonEntries.length > 0))) ||
    (input.terminalState === "failed" &&
      (!coverageValues.includes("failed") ||
        successfulEngines.length > 0 ||
        (!baseFailed &&
          reasonEntries.length > 0 &&
          input.reason !== firstFailedReason))) ||
    (input.terminalState === "cancelled" &&
      (!["CANCELLED", "PRIVATE_SLICE_SCOPE"].includes(input.reason ?? "") ||
        coverageValues.some((outcome) => outcome !== "not_applicable") ||
        reasonEntries.length > 0)) ||
    !reasonsMatchFailedEngines ||
    (baseFailed && reasonEntries.length > 0) ||
    ((input.terminalState === "failed" ||
      input.terminalState === "cancelled") &&
      input.findings.length > 0)
  ) {
    throw new Error("invalid publication metadata");
  }
  for (const specialist of SPECIALISTS) {
    if (
      !specialistCoverageOutcomeSchema.safeParse(input.coverage[specialist])
        .success
    ) {
      throw new Error("invalid publication coverage");
    }
  }
  if (input.findings.length > 1_024) {
    throw new Error("invalid publication findings");
  }
  const findingIds = new Set<string>();
  const engineRules = new Set<string>();
  for (const finding of input.findings) {
    const parsed = brokerDerivedFindingSchema.safeParse(finding);
    const engineRule = `${finding.engine}\0${finding.rule_id}`;
    if (
      !parsed.success ||
      finding.request_id !== input.requestId ||
      finding.repository_id !== input.repositoryId ||
      !["complete", "partial"].includes(input.coverage[finding.engine]) ||
      findingIds.has(finding.finding_id) ||
      engineRules.has(engineRule)
    ) {
      throw new Error("invalid publication findings");
    }
    findingIds.add(finding.finding_id);
    engineRules.add(engineRule);
  }
}
