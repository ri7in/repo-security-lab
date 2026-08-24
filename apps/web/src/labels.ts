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
    detail:
      "Every check that ran on this repository finished. Some checks are not switched on yet, and the columns beside this one say which ones did run.",
  },
  empty: {
    text: "Empty",
    tone: "skipped",
    detail: "This repository has no files at the scanned commit, so there was nothing to read.",
  },
  partial: {
    text: "Partly scanned",
    tone: "problem",
    detail:
      "Some checks finished and at least one did not. The other entries for this repository say which one, and every check that did finish still counts.",
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
    text: "Fork, skipped",
    tone: "skipped",
    detail:
      "This is a fork, so it was not checked. The code belongs to the original project: anything found here would be someone else's to fix, and reporting it against you would be wrong.",
  },
  ARCHIVE_LIMIT: {
    text: "Too big",
    tone: "skipped",
    detail:
      "This repository is over the size ceiling the free tier allows: 250 MB packed or 1 GB unpacked. It stays unscanned until that ceiling moves, so re-running today will not change it.",
  },
  ARCHIVE_UNSAFE: {
    text: "Archive refused",
    tone: "problem",
    detail:
      "The downloaded archive held an entry this scanner will not write to disk, such as a path pointing outside its own folder or a device node. It was refused and deleted unopened. Ordinary symbolic links are skipped rather than refused, so this is not one of those.",
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
  // "Clear" stated a verdict where the field only records that the check ran,
  // so a repository with a leaked key in the findings table below read "Clear"
  // in its own row. Coverage says what happened, never what was concluded.
  complete: {
    text: "Fully scanned",
    tone: "ok",
    detail:
      "Gitleaks 8.30.1 read every file under 20 MB at the exact commit named for this scan. It does not read earlier commits, so a secret that was committed and then removed is not covered. Anything it matched is in the findings table further down the page.",
  },
  partial: {
    text: "Partly scanned",
    tone: "problem",
    detail:
      "This check started and did not reach the whole repository, so treat a quiet result here as incomplete rather than as clean.",
  },
  // Reached on the live service only by a repository that was skipped before
  // a single file was downloaded, which is not a clean result and must not
  // wear the colour of one.
  not_applicable: {
    text: "Not scanned",
    tone: "skipped",
    detail:
      "Nothing here was read. Either the repository was skipped before download, or it holds nothing this check applies to. Green would be a lie either way.",
  },
  unsupported: {
    text: "Not yet covered",
    tone: "skipped",
    detail: "There is relevant code here, but this check is not switched on yet.",
  },
  failed: { text: "Failed", tone: "problem", detail: "This check did not finish." },
  // Keyed `pending` until now, while the contract sends `waiting`
  // (SPECIALIST_PROGRESS_STATES). Every not-yet-started row therefore fell
  // through to UNKNOWN and wore a red chip reading "this is a bug in this
  // tool" for the whole of every live scan, which is the screen every first
  // visitor watches.
  waiting: { text: "Waiting", tone: "active", detail: "This check has not started yet." },
};

const UNKNOWN: Label = {
  text: "Unknown",
  tone: "problem",
  detail:
    "An unrecognized state, which is a bug in this tool rather than a problem with your code. The report id is in the address bar if you want to send it in.",
};

/**
 * Why a whole scan stopped, as opposed to why one repository did.
 *
 * These are separate maps on purpose. GITHUB_NOT_FOUND against a repository
 * means it disappeared between being listed and being scanned; against a
 * request it means the account does not exist. The status line was reading the
 * repository wording, so a mistyped username was told a repository had gone
 * private.
 *
 * The API's own rejection codes live here too. Every one of them used to
 * collapse into "something went wrong that this page cannot explain, and the
 * report id in the address bar is what to send in", over a request that was
 * never created and therefore had no report id.
 */
const REQUEST_REASONS: Record<string, string> = {
  GITHUB_NOT_FOUND:
    "GitHub has no user account with that name. Check the spelling. This scans user accounts, so an organisation will not work here either.",
  GITHUB_RATE_LIMIT:
    "GitHub is rate limiting this service right now. It clears on its own, usually within the hour.",
  GITHUB_AUTH:
    "GitHub refused this service's credentials. That is a fault at this end, not yours.",
  GITHUB_NETWORK:
    "The connection to GitHub failed part way through. Running the scan again usually works.",
  D1_WRITE_RESERVE:
    "This service has used its free database allowance for the day. It resets overnight.",
  REPOSITORY_CHANGED:
    "The account changed while it was being read. Running the scan again picks up the new state.",
  CANCELLED: "This scan was cancelled before it finished.",
  PRIVATE_SLICE_SCOPE:
    "Scanning is limited to the operator's own account at the moment. Existing report links still work.",
  INVALID_USERNAME:
    "That is not a GitHub username. Letters, numbers and single hyphens, and it cannot start or end with a hyphen.",
  // The running scan's id is deliberately not handed back. Reports are public
  // to anyone holding the link and the privacy page promises the link is
  // unguessable, which would stop being true if submitting a username returned
  // the id of a scan somebody else had started. So this points at the one
  // place the visitor's own link is already kept.
  DUPLICATE_ACTIVE_REQUEST:
    "A scan of that account is already running. Wait for it to finish rather than starting a second one. If you started it, it is under Your past scans below.",
  RATE_LIMITED:
    "Too many scans too quickly. This service allows two a minute per account and five a minute per visitor.",
  CAPACITY_EXHAUSTED:
    "This service has used its free allowance for the day. It resets overnight.",
  EMAIL_UNAVAILABLE:
    "The email option is not available right now. The scan itself is unaffected.",
  REQUEST_FAILED:
    "The service did not answer. Check your connection and try again.",
};

/** The written explanation for a stored failure code, if there is one. */
export function failureDetail(code: string): string | undefined {
  return REQUEST_REASONS[code] ?? REASONS[code]?.detail;
}

/** Every request-level code this page can explain, for the guard test. */
export const EXPLAINED_REQUEST_CODES: readonly string[] =
  Object.keys(REQUEST_REASONS);

/** The visible outcome for a repository row, reason folded into the label. */
export function repositoryLabel(state: string, reason?: string): Label {
  const base = REPOSITORY_STATES[state] ?? UNKNOWN;
  if (reason === undefined) return base;
  const explained = REASONS[reason];
  if (explained === undefined) return base;
  // A partly scanned repository keeps its own headline.
  //
  // The reason on a partial row names ONE engine that failed, and letting it
  // win produced rows that contradicted themselves: a repository whose secret
  // scan came back clean and whose AI review failed was headlined "Scanner
  // error", which blames the check that worked. The per-engine columns are
  // right there and already say which one it was, so the reason goes to the
  // hover instead of the chip.
  if (state === "partial") {
    return { ...base, detail: `${base.detail} ${explained.detail}` };
  }
  // On a failed or cancelled row the reason IS the whole story, and "failed"
  // on its own tells a visitor nothing they can act on.
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
      "The reader saw some of this repository but not all of it. Files over 256 KB, files past the request's token budget, and files outside the languages it reads are left out, and so is anything past the four hundredth file. Whatever it did confirm is shown.",
  },
  not_applicable: {
    text: "Not reviewed",
    tone: "skipped",
    detail:
      "The full code review did not run here: this repository was skipped before download, or it holds no source file in a language the reviewer reads. Any secret-scan finding it did produce is still put to the review council.",
  },
  unsupported: {
    text: "Not reviewed",
    tone: "skipped",
    detail:
      "A scan reviews at most 3 repositories, and only while the shared daily budget lasts; this repository was not among the ones reviewed. The secret scan still ran on it, and its entry says how that went.",
  },
  // Deliberately does not name a cause. It once claimed the provider was
  // unreachable, which the stored reason often contradicted, and inventing a
  // rationale on a security page is worse than saying less.
  failed: {
    text: "Review failed",
    tone: "problem",
    detail:
      "The code review did not finish for this repository, usually because the model provider could not be reached or returned nothing usable. The secret scan is unaffected and its result stands.",
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

/**
 * The workflow audit column, live since zizmor was switched on 2026-08-24.
 *
 * Most repositories legitimately have no GitHub Actions workflows, so the
 * empty case is worded as a fact about the repository rather than as a check
 * that went wrong. Reports from before the switch-on carry `unsupported`
 * everywhere, and that history renders honestly as "Not switched on".
 */
const ZIZMOR_COVERAGE: Record<string, Label> = {
  complete: {
    text: "Audited",
    tone: "ok",
    detail:
      "Every GitHub Actions workflow file in this repository was checked offline against zizmor 1.29.0's audit rules.",
  },
  partial: {
    text: "Partly audited",
    tone: "problem",
    detail:
      "The workflow audit saw some of this repository's workflow files but not all of them, so its findings here are a floor rather than a total.",
  },
  not_applicable: {
    text: "No workflows",
    tone: "skipped",
    detail:
      "This repository has no GitHub Actions workflow files, so there was nothing for the workflow audit to read. That is a fact about the repository, not a failure.",
  },
  unsupported: {
    text: "Not switched on",
    tone: "skipped",
    detail:
      "The workflow audit was not running when this scan happened. Scans made after 24 August 2026 include it wherever workflow files exist.",
  },
  failed: {
    text: "Audit failed",
    tone: "problem",
    detail:
      "The workflow audit did not finish for this repository. Its other entries say how the rest of the scan went.",
  },
  waiting: {
    text: "Waiting",
    tone: "active",
    detail: "This repository has not reached the workflow audit yet.",
  },
};

/** The visible outcome of the workflow audit for one repository. */
export function zizmorCoverageLabel(coverage: string): Label {
  return ZIZMOR_COVERAGE[coverage] ?? UNKNOWN;
}
