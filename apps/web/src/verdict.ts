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
  /** Why the request stopped, if it stopped. There is no verdict then. */
  stoppedBecause?: string,
): Verdict {
  // A scan that never ran has no result, and the empty ledger under it used to
  // produce "Nothing to check. someone has no public repositories", which is a
  // reassuring sentence about a lookup that failed. On a security tool a false
  // all-clear is the worst output there is.
  if (stoppedBecause !== undefined) {
    return {
      tone: "concern",
      text: `This scan stopped before it finished, so it has no result. ${stoppedBecause}`,
    };
  }
  const total = repositories.length;
  const skipped = uncheckedCount(repositories);
  const checked = total - skipped;

  const unexamined =
    skipped === 0
      ? ""
      : ` ${String(skipped)} of ${String(total)} ${skipped === 1 ? "repository was" : "repositories were"} ` +
        "not fully checked, so there may be more.";

  if (findings.length > 0) {
    return {
      tone: "concern",
      text:
        `${String(findings.length)} thing${findings.length === 1 ? "" : "s"} to fix in ` +
        `${username}'s public code, ${findings.length === 1 ? "listed" : "all listed"} below ` +
        `with the file and the line.${unexamined}`,
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
      // "Could not be checked" told people something had broken when the
      // usual cause is a fork this tool deliberately does not scan.
      text:
        `Nothing exposed in the ${String(checked)} ${checked === 1 ? "repository" : "repositories"} that were scanned. ` +
        `${String(skipped)} ${skipped === 1 ? "was" : "were"} skipped or could not be read, and the ledger below says which and why.`,
    };
  }
  // Names the checker and what it does, rather than promising "clean". The
  // secret scan covers every repository; the code review covers at most three,
  // and a headline that blurs the two overstates the whole result.
  return {
    tone: "clear",
    text:
      `No exposed credentials. The secret scan read all ${String(total)} public ` +
      `${total === 1 ? "repository" : "repositories"} and matched nothing.`,
  };
}
