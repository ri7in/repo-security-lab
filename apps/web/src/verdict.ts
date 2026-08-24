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
 * Repositories the secret scan finished, as opposed to started.
 *
 * The verdict and the findings panel sit a few inches apart and both name a
 * count of scanned repositories. One took this and the other took
 * secretScannedCount, so a report with one partly scanned repository said
 * "the 2 the secret scan read in full" above "the 3 the secret scan read".
 */
export function fullyScannedCount(
  repositories: readonly RepositoryRow[],
): number {
  return repositories.filter(
    (repository) => repository.coverage.gitleaks === "complete",
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
  // Read in full, not "read at all". secretScannedCount includes partly
  // scanned repositories, which are also counted in `skipped`, so the same
  // repository appeared on both sides of the sentence: three repositories
  // produced "the 2 that were scanned. 2 did not finish."
  const checked = fullyScannedCount(repositories);

  const unexamined =
    skipped === 0
      ? ""
      : ` ${String(skipped)} ${skipped === 1 ? "repository" : "repositories"} did not finish, so there may be more.`;
  const deliberate =
    onPurpose === 0
      ? ""
      : ` ${String(onPurpose)} ${onPurpose === 1 ? "was" : "were"} skipped on purpose, as forks or as repositories with no commit.`;

  if (findings.length > 0) {
    // "with the file and the line" was promised unconditionally. `locations`
    // is optional on a published finding, and one without any renders as "not
    // located", so the headline was making a promise the table under it broke.
    const located = findings.every(
      (finding) => (finding.locations?.length ?? 0) > 0,
    );
    return {
      tone: "concern",
      text:
        `${String(findings.length)} thing${findings.length === 1 ? "" : "s"} to fix in ` +
        `${username}'s public code, ${findings.length === 1 ? "listed" : "all listed"} below` +
        `${located ? " with the file and the line" : ", with the file and the line wherever the scanner recorded one"}.` +
        `${unexamined}${deliberate}`,
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
    // Nothing was read at all, so there is no result to lead with. This used
    // to open "Nothing exposed in the 0 repositories that were scanned",
    // which puts a reassuring clause and the word "nothing exposed" at the
    // front of a scan that read no code whatsoever.
    if (checked === 0) {
      return {
        tone: "concern",
        text:
          `No repository here was read, so this scan has no result. ` +
          `${String(skipped)} did not finish, and the ledger below says why.${deliberate}`,
      };
    }
    return {
      tone: "partial",
      // "Could not be checked" told people something had broken when the
      // usual cause is a fork this tool deliberately does not scan, so the
      // two are counted and worded separately now.
      //
      // `checked` counts the repositories the scanner read in full. It used to
      // include partly scanned ones, which are also in `skipped`, so three
      // repositories produced "the 2 that were scanned. 2 did not finish."
      text:
        `Nothing exposed in the ${String(checked)} ${checked === 1 ? "repository" : "repositories"} the secret scan read in full. ` +
        `${String(skipped)} did not finish, and the ledger below says why.${deliberate}`,
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

/**
 * The line that stands where the ledger would be, when it has no rows.
 *
 * Two very different things land here: a scan that stopped before discovery,
 * and an account that genuinely has no public repositories. Both were told
 * "the scan stopped before it got that far", under a heading reading "Scan
 * finished".
 */
export function emptyLedgerText(stopped: boolean): string {
  return stopped
    ? "No repositories were listed, because the scan stopped before it got that far."
    : "This account has no public repositories, so there was nothing to scan.";
}

/**
 * The sentence under an empty findings table.
 *
 * The standing one credits Gitleaks with reading a commit. Over an account
 * with no public repositories no commit was read, and that sentence rendered
 * in green directly under an amber verdict saying there was nothing to check.
 * On a security page the green box is the one a reader believes.
 */
export interface NothingFound {
  readonly text: string;
  /** True when the panel must not wear the all-clear green. */
  readonly neutral: boolean;
}

export function nothingFoundText(
  total: number,
  scanned: number,
  missed: number,
  standard: string,
): NothingFound {
  if (total === 0) {
    return {
      text: "There was nothing to scan, so nothing was checked and nothing was found.",
      neutral: true,
    };
  }
  // Keyed on the repository count until now, so an account whose repositories
  // all failed still got the green panel and the sentence crediting Gitleaks
  // with reading a commit, directly under a ledger of red rows. Nothing was
  // read. A request reaches `complete` as soon as every repository is
  // terminal, and `failed` is terminal, so this was reachable in production.
  if (scanned === 0) {
    return {
      text: "Nothing here was read, so nothing was found. The ledger above says what happened to each repository.",
      neutral: true,
    };
  }
  if (missed > 0) {
    return {
      text:
        `No exposed credential in the ${String(scanned)} ${scanned === 1 ? "repository" : "repositories"} the secret scan read in full. ` +
        `${String(missed)} did not finish, so this is not the whole picture.`,
      neutral: true,
    };
  }
  return { text: standard, neutral: false };
}
