/**
 * Plain English for every internal state a visitor can see.
 *
 * The ledger used to print enum names straight from the database, so a skipped
 * fork appeared as "cancelled · PRIVATE SLICE SCOPE" and a checker with nothing
 * to do appeared as "not applicable". Both read as failures. Neither is one.
 *
 * Three tones, and the distinction is the whole point:
 *
 *   ok       the check ran and found nothing wrong
 *   skipped  deliberately not scanned, and that is the correct outcome
 *   problem  something genuinely went wrong and is worth reading
 *
 * Every label carries a `detail` because a one-word chip cannot explain itself,
 * and a visitor who cannot tell "fine" from "broken" assumes broken.
 */

export type Tone = "ok" | "skipped" | "problem" | "active";

export interface Label {
  readonly text: string;
  readonly tone: Tone;
  readonly detail: string;
}

const REPOSITORY_STATES: Record<string, Label> = {
  complete: {
    text: "Scanned",
    tone: "ok",
    detail: "Every check that applies to this repository ran to completion.",
  },
  empty: {
    text: "Empty",
    tone: "skipped",
    detail: "This repository has no files at the scanned commit, so there was nothing to read.",
  },
  partial: {
    text: "Partly scanned",
    tone: "problem",
    detail: "Some checks finished and at least one did not. The Secrets column says which.",
  },
  cancelled: {
    text: "Skipped",
    tone: "skipped",
    detail: "This repository was deliberately not scanned.",
  },
  failed: {
    text: "Could not scan",
    tone: "problem",
    detail: "This repository could not be read. The reason is shown next to it.",
  },
  discovered: { text: "Queued", tone: "active", detail: "Found, waiting for a scanner." },
  waiting: { text: "Queued", tone: "active", detail: "Waiting for a free scanner." },
  leased: { text: "Starting", tone: "active", detail: "A scanner has picked this repository up." },
  acquiring: { text: "Downloading", tone: "active", detail: "Fetching the snapshot from GitHub." },
  guarding: { text: "Unpacking", tone: "active", detail: "Checking the archive is safe to open." },
  scanning: { text: "Scanning", tone: "active", detail: "Reading the code inside the sandbox." },
  normalizing: { text: "Scanning", tone: "active", detail: "Turning results into the report format." },
  cleaning: { text: "Cleaning up", tone: "active", detail: "Deleting the downloaded source." },
  uploading: { text: "Reviewing", tone: "active", detail: "Reviewing findings before publishing." },
  waiting_to_publish: { text: "Finishing", tone: "active", detail: "About to publish the result." },
};

/**
 * Why a repository was skipped or failed.
 *
 * `PRIVATE_SLICE_SCOPE` is the one worth calling out. On the public service the
 * only thing that triggers it is a fork, but the name is left over from when
 * the tool ran against an allowlist. The internal name stays; the visitor sees
 * what actually happened.
 */
const REASONS: Record<string, Label> = {
  PRIVATE_SLICE_SCOPE: {
    text: "Not checked",
    tone: "skipped",
    detail:
      "This is a fork, so it was not checked. The code belongs to the original project: anything found here would be someone else's to fix, and reporting it against you would be wrong.",
  },
  ARCHIVE_LIMIT: {
    text: "Not checked",
    tone: "skipped",
    detail:
      "This repository is too big to check on the free compute this runs on: over 250 MB packed or 1 GB unpacked. When there is enough free compute to afford it, it will be checked. Not today.",
  },
  ARCHIVE_UNSAFE: {
    text: "Unsafe archive",
    tone: "problem",
    detail:
      "The downloaded archive tried something a normal repository never does, such as writing outside its own folder. It was refused and deleted unopened.",
  },
  ARCHIVE_INVALID: {
    text: "Broken archive",
    tone: "problem",
    detail: "GitHub returned an archive that could not be read as a valid tar.gz.",
  },
  GITHUB_RATE_LIMIT: {
    text: "GitHub rate limit",
    tone: "problem",
    detail: "GitHub temporarily refused more requests. Running the scan again later usually clears it.",
  },
  GITHUB_NOT_FOUND: {
    text: "Not found",
    tone: "skipped",
    detail: "The repository disappeared or became private between being listed and being scanned.",
  },
  GITHUB_NETWORK: {
    text: "Network problem",
    tone: "problem",
    detail: "The download failed part way through. Running the scan again usually works.",
  },
  GITHUB_AUTH: {
    text: "Access refused",
    tone: "problem",
    detail: "GitHub refused the request for this repository.",
  },
  REPOSITORY_CHANGED: {
    text: "Changed mid-scan",
    tone: "skipped",
    detail: "Someone pushed while this was being scanned, so the result would not have matched any real commit.",
  },
  SCANNER_TIMEOUT: {
    text: "Timed out",
    tone: "problem",
    detail: "The scanner took too long on this repository and was stopped.",
  },
  SCANNER_MEMORY_LIMIT: {
    text: "Too much memory",
    tone: "problem",
    detail: "The scanner needed more memory than the free runner has.",
  },
  SCANNER_OUTPUT_LIMIT: {
    text: "Too many results",
    tone: "problem",
    detail: "The scanner produced more output than the reader accepts.",
  },
  SCANNER_INTERNAL: {
    text: "Scanner error",
    tone: "problem",
    detail: "The scanner exited unexpectedly on this repository.",
  },
  FINDING_LIMIT: {
    text: "Capped",
    tone: "problem",
    detail: "This repository has more findings than one report can list. The ones shown are real; there are more.",
  },
  NORMALIZATION_REJECTED: {
    text: "Result refused",
    tone: "problem",
    detail: "The scanner's output did not match the strict format the report accepts, so it was thrown away rather than trusted.",
  },
  CANCELLED: { text: "Cancelled", tone: "skipped", detail: "This scan was stopped before it finished." },
  LEASE_RETRY_EXHAUSTED: {
    text: "Gave up",
    tone: "problem",
    detail: "This repository was retried several times and never completed.",
  },
  D1_WRITE_RESERVE: {
    text: "Daily limit",
    tone: "problem",
    detail: "The service hit its free daily database allowance. Try again tomorrow.",
  },
  SOURCE_CLEANUP_FAILED: {
    text: "Cleanup failed",
    tone: "problem",
    detail: "The downloaded source could not be deleted, so the result was withheld rather than published.",
  },
  UNSUPPORTED_ECOSYSTEM: {
    text: "Unsupported",
    tone: "skipped",
    detail: "This project uses a package manager the dependency checker does not read yet.",
  },
};

const COVERAGE: Record<string, Label> = {
  complete: { text: "Clear", tone: "ok", detail: "This check ran over the whole repository." },
  partial: {
    text: "Partial",
    tone: "problem",
    detail: "This check ran but could not cover everything.",
  },
  not_applicable: {
    text: "Nothing to check",
    tone: "ok",
    detail:
      "This repository contains nothing this check applies to, so there was nothing to find. This is a clean result, not a failure.",
  },
  unsupported: {
    text: "Not yet covered",
    tone: "skipped",
    detail: "There is relevant code here, but this check is not switched on yet.",
  },
  failed: { text: "Failed", tone: "problem", detail: "This check did not finish." },
  pending: { text: "Waiting", tone: "active", detail: "This check has not started yet." },
};

const UNKNOWN: Label = {
  text: "Unknown",
  tone: "problem",
  detail: "An unrecognised state. This is a bug worth reporting.",
};

/** The visible outcome for a repository row, reason folded into the label. */
export function repositoryLabel(state: string, reason?: string): Label {
  const base = REPOSITORY_STATES[state] ?? UNKNOWN;
  if (reason === undefined) return base;
  const explained = REASONS[reason];
  if (explained === undefined) return base;
  // The reason is more specific than the state, so it wins the chip text.
  return {
    text: explained.text,
    tone: explained.tone,
    detail: explained.detail,
  };
}

/** The visible outcome for one check on one repository. */
export function coverageLabel(coverage: string, reason?: string): Label {
  const explained = reason === undefined ? undefined : REASONS[reason];
  if (explained !== undefined) return explained;
  return COVERAGE[coverage] ?? UNKNOWN;
}

/**
 * The AI review column, read from that repository's own coverage.
 *
 * It used to be read from a request-level lane field that never changed from
 * "ai_not_run", so a repository a model had genuinely read still said the
 * review had not run. Coverage is per repository and carries the full
 * vocabulary, including the difference between "there was no code to read" and
 * "the reader was not reached".
 */
const AI_COVERAGE: Record<string, Label> = {
  complete: {
    text: "Reviewed",
    tone: "ok",
    detail:
      "A model read this repository's code and a panel of judges from different model families confirmed anything it flagged.",
  },
  partial: {
    text: "Partly reviewed",
    tone: "problem",
    detail:
      "The review started and did not finish, usually because there was more to check than one day's free model budget covers. Anything it did confirm is shown.",
  },
  not_applicable: {
    text: "No code to read",
    tone: "ok",
    detail:
      "This repository holds no source a code reviewer could read, so there was nothing for this check to do.",
  },
  unsupported: {
    text: "Not reviewed",
    tone: "skipped",
    detail:
      "The daily free model budget is small and shared, so only the most recently updated repositories get a full code review. The secret scan ran on this one either way.",
  },
  failed: {
    text: "Review failed",
    tone: "problem",
    detail:
      "The model provider could not be reached for this repository. The secret scan is unaffected and its result stands.",
  },
  waiting: {
    text: "Waiting",
    tone: "active",
    detail: "This repository has not reached the review step yet.",
  },
};

/** The visible outcome of the AI review pass for one repository. */
export function aiCoverageLabel(coverage: string): Label {
  return AI_COVERAGE[coverage] ?? UNKNOWN;
}
