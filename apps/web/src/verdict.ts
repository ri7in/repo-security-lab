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

/**
 * Repositories deliberately not scanned, which is not a gap in the result.
 *
 * A fork and a repository with no commit are both correct outcomes. Counting
 * them as gaps made a report where every intended check succeeded still say
 * "5 of 23 repositories were not fully checked, so there may be more", of
 * which four were forks whose own label says anything found in them would be
 * somebody else's to fix.
 */
export function skippedOnPurposeCount(
  repositories: readonly RepositoryRow[],
): number {
  return repositories.filter((repository) =>
    ["cancelled", "empty"].includes(repository.state),
  ).length;
}

/** Repositories that were meant to finish and did not. */
export function uncheckedCount(
  repositories: readonly RepositoryRow[],
): number {
  return repositories.filter((repository) =>
    ["failed", "partial"].includes(repository.state),
  ).length;
}

/**
 * Repositories the secret scan actually read.
 *
 * Read from that repository's own coverage, because the clear verdict names
 * the secret scan specifically and a repository can be terminal without the
 * scanner ever having opened it.
 */
export function secretScannedCount(
  repositories: readonly RepositoryRow[],
): number {
  return repositories.filter((repository) =>
    ["complete", "partial"].includes(repository.coverage.gitleaks),
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
  const onPurpose = skippedOnPurposeCount(repositories);
  const checked = secretScannedCount(repositories);

  const unexamined =
    skipped === 0
      ? ""
      : ` ${String(skipped)} ${skipped === 1 ? "repository" : "repositories"} did not finish, so there may be more.`;
  const deliberate =
    onPurpose === 0
      ? ""
      : ` ${String(onPurpose)} ${onPurpose === 1 ? "was" : "were"} skipped on purpose, as forks or as repositories with no commit.`;

  if (findings.length > 0) {
    return {
      tone: "concern",
      text:
        `${String(findings.length)} thing${findings.length === 1 ? "" : "s"} to fix in ` +
        `${username}'s public code, ${findings.length === 1 ? "listed" : "all listed"} below ` +
        `with the file and the line.${unexamined}${deliberate}`,
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
      // usual cause is a fork this tool deliberately does not scan, so the
      // two are counted and worded separately now.
      text:
        `Nothing exposed in the ${String(checked)} ${checked === 1 ? "repository" : "repositories"} that were scanned. ` +
        `${String(skipped)} ${skipped === 1 ? "did" : "did"} not finish, and the ledger below says why.${deliberate}`,
    };
  }
  if (onPurpose > 0) {
    // Nothing went wrong. Everything that was meant to be scanned was.
    return {
      tone: "clear",
      text:
        `No exposed credentials. The secret scan read all ${String(checked)} ` +
        `${checked === 1 ? "repository" : "repositories"} it was meant to, at their current commit, and matched nothing.` +
        deliberate,
    };
  }
  // Names the checker and what it does, rather than promising "clean". The
  // secret scan covers every repository; the code review covers at most three,
  // and a headline that blurs the two overstates the whole result.
  const read = secretScannedCount(repositories);
  return {
    tone: "clear",
    text:
      `No exposed credentials. The secret scan read ${String(read)} of ${String(total)} public ` +
      `${total === 1 ? "repository at its" : "repositories at their"} current commit and matched nothing.`,
  };
}
