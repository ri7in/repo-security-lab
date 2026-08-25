# Publishing source locations

**Status:** settled and shipped. Reports name the file and line of every
finding, for any scanned account.

## The decision

A report names the path and the line of each match. It cannot name anything
else about the source: no snippet, no matched text, no secret value. Gitleaks
runs under `--redact=100`, so the value does not exist on this side of the
scanner at all, and `publicFindingSchema` in `packages/contracts/src/api.ts`
has no field capable of holding one.

## Why the obvious objection does not settle it

The objection is that a report hands an attacker a precise, ranked, deduplicated
map of where a stranger's live credentials sit, and that nobody being scanned
consented to that.

The counter-argument is that the scanner is open source and the target
repositories are public, so an attacker can clone this repository and run the
same scan themselves for free. Nothing in a report is a capability they did not
already have. The marginal harm is convenience, not capability.

That distinction is real, but it is not by itself a defence, because
convenience is exactly what an attacker is buying. Three properties of the
deployed system are what make publishing defensible, and each is load-bearing:

- Reports are keyed by an opaque request id of 16 random bytes, not by
  username. There is no browsable route from a person to their report, so
  accounts cannot be enumerated.
- Reports carry `noindex` and are deleted 30 days after their last update, so
  they do not accumulate into a searchable corpus.
- The value is never present to publish. A location is a path and a line.

Remove any one of those and the decision should be revisited. In particular, a
username-addressable report route would turn this from a tool into a directory,
and must not be added.

## What a vague report would cost

A report that says "rule 17 matched a few times" is not the cautious version of
this product, it is a useless one. The person who most needs the path is the
owner, who has to go and rotate the credential. Withholding the location
protects nobody in the threat model above, because the attacker can recompute
it, while removing the entire value for the person who cannot.

## The proof this rests on

The egress guarantee is enforced by canary tests, not by review. A fixture
plants a known string in the source and the test asserts that string never
reaches a response, a log, or the database
(`packages/worker/test/worker.test.ts`).

The lesson worth keeping is how that proof failed once. The fixture planted
canaries only in file *contents* and asserted only on contents, so it would
have stayed green if paths had begun shipping. A guarantee is only as strong as
the thing the fixture actually varies: when the published surface changes, the
canary has to change with it, and the test must be watched going red before the
behaviour changes.
