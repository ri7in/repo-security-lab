# Security policy

The service is live and public at
[repo-security-lab.rivinsand.workers.dev](https://repo-security-lab.rivinsand.workers.dev).
Anyone can scan any public GitHub account, with no sign-up. Scanning runs on
GitHub Actions under enforced Bubblewrap isolation, and the AI code review is
on: it sends source from public repositories to OpenRouter, and a twelve line
excerpt around each secret-scan finding to Groq and to Google. `docs/privacy.md`
has the complete data boundary and `docs/threat-model.md` has the trust
boundaries.

Until 2026-08-24 this file said the opposite: that the repository was a private
preview, that public scan compute and AI source processing were disabled, and
that testing the public service was out of scope. All three had been untrue for
as long as the service had been live, which meant this policy was telling
researchers not to report the only thing that was actually deployed.

## Reporting

Use GitHub's private vulnerability-reporting flow on this repository. Include
the affected commit, the smallest safe reproduction, the trust boundary
crossed, and the impact.

Do not put secrets, access tokens, exploit payloads, source from somebody
else's repository, or personal email addresses in a report. A public report
names the file and line of each finding and expires 30 days after its last
update; a removal or privacy request needs only the opaque report id from the
address bar.

## In scope

- The live control plane, the report pages, and the public API.
- The scan worker and its isolation: anything that gets code from a scanned
  repository to execute, anywhere.
- The source-blind broker: anything that gets an archive-derived string out of
  the sandbox on the evidence channel, which is meant to carry only numeric
  manifest tokens and count buckets.
- The location channel: a path that escapes the repository, an absolute path,
  or traversal.
- Redaction: a secret value, a snippet, or a raw match reaching a report, a
  model provider, or a log.
- Anything that makes a report claim more coverage than actually ran.
- Ordinary use of the published username form, under `docs/acceptable-use.md`.

## Out of scope

- Denial of service, load testing, and deliberately exhausting the shared free
  tier budgets. The limits are documented and small on purpose.
- Findings that only say a scanner has false positives or misses things. The
  reports say so themselves.
- Reports about repositories the scanner read, rather than about the scanner.
  Send those to the repository's owner.

## What a report does and does not claim

This does not replace a penetration test and does not detect every
vulnerability. A `complete` state for a check means that named, version-pinned
check finished its documented scope on the exact commit it read. It is not a
claim that the repository is safe, and the reports are written to avoid making
that claim anywhere.
