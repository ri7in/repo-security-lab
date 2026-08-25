# What the service guarantees

Each item below is enforced in code and covered by tests. They are written as
guarantees rather than intentions: if one of them stops being true, the
statement here is a bug report.

## Target code is never executed

A scanned repository is hostile data. No dependency install, script, test,
build, or hook belonging to a scanned repository ever runs. Archives are
validated while streaming and extracted without executing anything they
contain.

## Nothing a repository controls can write into a report

The evidence channel out of the sandbox carries no archive-derived strings:
only manifest-issued numeric tokens and four count-bucket codes cross the
source-blind broker. Rule names, severities, and remediation text are looked up
on the trusted side from a fixed manifest.

Locations travel on a separate, deliberately narrow channel: a validated
relative path and a line number, capped per finding, with traversal and
absolute paths refused at the source. Matches, snippets, and secret values are
on neither channel. The reasoning is in
[locations-decision.md](locations-decision.md).

## A model cannot invent, and can only rarely delete

A model picks one of ten weakness classes. Every word a reader sees, the rule
name and the remediation included, is looked up from that class in a fixed
manifest, and the severity is that class's fixed rating. A reader that
mislabels the class shifts the severity with it; no judge is asked whether the
class fits, only whether the finding is real.

A model can delete a secret-scan finding, but only when the two most trusted
judges that answered both reject it. Fewer than two judges, two of one family,
an exhausted quota, a provider timing out, or any thrown error all keep the
finding, because showing a false positive is far cheaper than deleting a real
one. Deletion is per finding: a false alarm dies alone and the finding beside
it survives with its exact count intact. No model declares a repository safe;
the verdict is computed from coverage.

## Source does leave the machine, and the pages say so

The AI pass sends public source code to model providers. A reader on OpenRouter
takes whole source files with every secret-scanner line blanked first.
Separately, an excerpt of up to 120 lines around each secret-scanner finding
goes to OpenRouter, Google, and Groq, so models from different companies can
vote on whether it is a false alarm.

Providers may keep or train on what they receive, which is what pays for the
free tier this runs on. The privacy page and the site footer both say so.
`AI_REVIEW_ENABLED=false` stops both passes.

## Scanners are pinned, and cannot silently claim coverage

Gitleaks and Zizmor have exact version and hash pins, strict adapters, and
source-blind manifests. An engine that is not enabled reports `unsupported` or
`not_applicable` rather than quietly contributing nothing to a green result.

## Forks are not scanned

Owning a fork does not make its upstream source yours. The ledger shows the row
and says it was skipped, rather than hiding it.

## Reports expire, and capacity is capped

Abandoned active reports fail after 24 hours, and terminal reports expire 30
days after their last update. Privacy and acceptable-use policies ship with the
site.

Global admission is capped at 240 reports per UTC day, below the 288-per-day
retention drain. Scan admission stops at 40% of the D1 free allowance, and
privacy maintenance keeps a protected band up to 60%.

## Report email is off

If it is ever switched on, it uses an encrypted one-shot queue, and public
scanning keeps it structurally disabled until a recipient-consent flow exists.
