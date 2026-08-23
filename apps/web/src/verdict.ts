import type { PublicFinding, RepositoryRow } from "@app/contracts";

/**
 * The one sentence a visitor came for.
 *
 * "You are safe" is a bigger claim than this tool can make, so the wording says
 * what was actually examined and what came back. A repository that was skipped,
 * failed, or only partly finished keeps the verdict off "clear": a check that
 * did not run is not a check that passed, and rolling those into a clean
 * headline is exactly the dishonesty this whole ledger exists to avoid.
 */
export type VerdictTone = "clear" | "partial" | "concern";

export interface Verdict {
  readonly tone: VerdictTone;
  readonly text: string;
}

/** Repositories that were not fully examined, whatever the reason. */
export function uncheckedCount(
  repositories: readonly RepositoryRow[],
): number {
  return repositories.filter((repository) =>
    ["cancelled", "failed", "partial"].includes(repository.state),
  ).length;
}

export function summarizeVerdict(
  username: string,
  repositories: readonly RepositoryRow[],
  findings: readonly PublicFinding[],
): Verdict {
  const total = repositories.length;
  const skipped = uncheckedCount(repositories);
  const checked = total - skipped;

  if (findings.length > 0) {
    return {
      tone: "concern",
      text:
        `${String(findings.length)} thing${findings.length === 1 ? "" : "s"} to fix in ` +
        `${username}'s public code. Every one is listed below with the file and line.`,
    };
  }
  if (total === 0) {
    // No repositories is not a clean bill of health, it is nothing to report.
    return {
      tone: "partial",
      text: `Nothing to check. ${username} has no public repositories.`,
    };
  }
  if (skipped > 0) {
    return {
      tone: "partial",
      text:
        `Nothing exposed in the ${String(checked)} ${checked === 1 ? "repository" : "repositories"} that were checked. ` +
        `${String(skipped)} could not be checked, and ${skipped === 1 ? "it is" : "they are"} marked below.`,
    };
  }
  return {
    tone: "clear",
    text: `Nothing exposed. All ${String(total)} public ${total === 1 ? "repository" : "repositories"} were checked and came back clean.`,
  };
}
