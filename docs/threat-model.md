# Threat model

**Scope:** the live service. This document covers the local scanner slice, the
Cloudflare Worker and D1 control plane, and the GitHub Actions pull worker that
runs under enforced Bubblewrap isolation. Public scanning is open to anyone.
Nothing here claims that macOS process boundaries provide production
sandboxing; the isolation that matters runs on Linux.

## Assets and security objectives

- Never execute a target repository's code, dependencies, scripts, hooks,
  tests, builds, containers, or configuration-driven commands.
- Keep repository source, paths, snippets, scanner matches, and detected secret
  values out of hosted persistence, API responses, and logs.
- Preserve every discovered repository in an exhaustive coverage ledger; a
  limit or refusal must become an explicit outcome, never an omission.
- Keep deterministic findings immutable. AI may add separately grounded
  candidates in a future lane but may not suppress scanner evidence.
- Bind acquisition and publication to GitHub's immutable account/repository
  identities and an exact commit object ID.

## Adversaries and untrusted inputs

The visitor controls the submitted username and request timing. GitHub and the
network may return malformed, oversized, inconsistent, redirected, truncated,
or rate-limited responses. A public repository owner controls every archive
byte, filename, tar header, PAX record, file body, scanner configuration file,
and string the scanner may emit. Scanner output is treated as compromised even
when the executable itself matches the pinned release hash.

Local machine administrators and a compromised trusted scanner binary are
outside the private slice's containment guarantee. Public release therefore
requires the separate Linux privilege/no-network/cgroup/tmpfs boundary and
project-attested scanner provenance described below.

## Trust boundaries

### Control plane

The public Worker validates a closed GitHub-login grammar, applies Cloudflare
rate limits, and creates each request durably before discovery. Public scope is
off by default. Completed source-blind reports are public and require no login.
Their strict schema omits internal finding/request IDs and detail references
and has no field capable of carrying a path, snippet, match, or secret. Signed
internal worker requests use bounded bodies, server-authoritative time,
rotating HMAC generations, and revocation. Security headers apply to API and
static assets.

D1 records the exhaustive ledger, materialized request totals, bounded finding
chunks, lease generations, and modeled daily write reservations. Request and
discovery reservations are atomic with their corresponding writes, and the
service fails closed with an explicit capacity response before it can exceed
the configured free-tier write budget. Workerd integration tests exercise the
real migration, transactions/batches, conflicts, lease ABA resistance,
idempotency, rate limiting, legacy-login refusal, and response headers.

The local API validates the same GitHub-login grammar and admits only configured
logins. On restart, the local
runtime replays durable accepted/discovering rows under the current login and
account-ID allowlists before it begins serving. Discovery then binds the
request to GitHub's immutable account ID and refuses IDs outside the private
allowlist. Complete pagination, stable totals, duplicate IDs, changing cursors,
and inconsistent account metadata fail closed.

### Acquisition and archive domain

Only exact commit archives are requested. The client manually accepts one
strict HTTPS codeload redirect and removes authorization before following it.
Response headers and streams are bounded and cancelled on rejection.

Archive bytes enter a tuple-keyed private scratch directory. The project-owned
parser accepts only regular files and directories and checks checksums,
padding, truncation, compressed/inflated/extracted/file sizes, expansion ratio,
entry count, depth, PAX metadata, Unicode normalization, case collisions,
traversal, links, devices, sparse entries, and ambiguous platform paths. Any
rejection removes only the destination created by that extraction attempt.

### Scanner and source-blind egress

Gitleaks runs without a shell, with a minimal environment, explicit trusted
configuration, target allowlisting disabled, full redaction, and time/output/
finding bounds. The adapter accepts only allowlisted rule IDs and verifies the
secret field is exactly redacted. Contextual match text is checked for the
redaction marker and discarded inside the hostile domain.

On POSIX, every scanner command runs as a new process-group leader and the
adapter terminates that complete group on leader exit and every bounded failure
path before accepting `close`; Windows fails closed until an equivalent job
boundary exists. A descendant can create a new session and escape a process
group, so this is cleanup defense in depth and does not weaken the separate
Linux cgroup/systemd public-release gate.

A separate iterative walk reads only extracted entry names and types under
independent entry/depth/path-byte ceilings. For the three unintegrated engines,
`not_applicable` means a complete anomaly-free walk proved no relevant input;
present input or a walk that cannot finish is `unsupported`. Dependency
relevance deliberately includes manifests and lockfile families that are not
yet proven scannable: only exact `package-lock.json` parsing has passed the
current pinned-OSV preflight, and no dependency specialist runs here.

The normalizer emits strict JSON containing numeric manifest tokens and four
count-bucket codes only. The trusted broker is constructed for one engine and
manifest, rejects unknown/duplicate/extra content, derives all display strings
from that manifest, and injects request/repository/commit identity from the
lease. Archive-derived strings have no representable field across this boundary.

### Cleanup, leases, and persistence

Each claim increments a durable generation. Worker transitions, heartbeats,
cleanup recovery, and publication compare the exact request/repository/worker/
generation tuple. Source-bearing work cannot be voluntarily released. An
expired generation remains parked until its exact scratch path is removed and
an expiry/generation compare-and-swap requeues or terminalizes it. Normal
publication removes and verifies the entire tuple root before broker acceptance.
If a lease expires after local source exists but before the durable cleaning
transition, the worker removes that exact generation immediately; the janitor
then performs the later durable compare-and-swap against the absent path.

SQLite and D1 persist only control-plane repository names, closed
coverage/failure states, and broker-derived finding metadata. Raw source,
paths, snippets, matches, scanner stderr, and secret values are absent from
their schemas. D1 detail rows are bounded to 100 normalized findings per chunk.

On a failed repository row, specialist `failed` means no reliable result was
available; it does not claim that specialist executed. The row-level fixed
reason carries the cause. Cancelled pre-source rows remain `not_applicable`.

### Report and AI lanes

Anonymous DTOs expose exhaustive status, coverage, and closed broker-derived
finding metadata plus a location: a validated relative path and a line number.
The public finding DTO still cannot express internal IDs, detail references,
snippets, matches, or secrets. Paths are refused at the source if they escape
the repository root or are absolute, and locations are capped per finding. A
separate full broker-record route exists only in explicit operator mode, which
requires a literal loopback bind and automatically enforces a matching Host
header. The composed runtime applies the same Host guard to every route.

The AI pass is networked and does send public repository source to external
providers. What it can send is bounded: files are collected from the extracted
snapshot with dependency and build directories skipped, every line the secret
scanner matched is blanked before packing, and the pack is capped in files and
tokens. What it can return is bounded harder: a file token, a line number, an
excerpt and a CWE from a closed vocabulary of ten. A model cannot name a rule,
set a severity, write prose into a report, choose which of its own flags get
judged, or address the judges reviewing it. The pass runs in the worker rather
than the sandbox because the sandbox has no network by design and this is the
one step that needs one.

## Abuse and privacy limits

The local runtime is intentionally single-operator and sequentially paced. The
deployed control-plane code has public source-blind reports, durable capacity
reservations, a protected 40%-to-60% privacy-maintenance write band, 240-report
daily admission, bounded read/write/internal
rate limits, switched-off encrypted email, 24-hour abandoned
work expiry, and automatic 30-day terminal-report deletion, but no public scan worker is
attached. The application does not persist requester IPs. Email ciphertext is
erased after delivery or final failure; a keyed abuse-control hash disappears
with the retained report. Forks are represented but refused before download because
owned forks can contain third-party source. Logs carry fixed event/result codes
only.

## Public-release gates

- Prove the committed bubblewrap scan-domain bundle on Linux and the owner OCI
  host: no network, hidden credentials, denied outside writes, clean environment,
  read-only pinned tools, private scratch, systemd memory/CPU/task ceilings, no
  swap, and crash/reboot cleanup.
- Maintain the deployed Worker/D1 control plane under Rivin's Cloudflare
  account and verify free-tier capacity alarms before third-party admission.
- Attach a non-root Linux or microVM scan-compute boundary with no target-code
  execution, default-deny egress after acquisition, resource ceilings, trusted
  read-only scanners, tuple cleanup, and crash/reboot proofs.
- AI source submission is ON. Sanitization (secret lines blanked before
  packing), opaque code mapping (numeric CWE tokens through a closed manifest),
  provider disclosure (the privacy page and the site footer) and the grounded
  reader-plus-council design are all in place. Zero-retention agreements with
  the providers are NOT: the free tiers this runs on are paid for with the
  data, the pages say so, and that is the standing trade.
- Add project-attested/reproducible scanner provenance. A release archive hash
  proves identity, not that the upstream build is trustworthy.
- Integrate and test dependency and source-rule specialists. The workflow lane
  is implemented but remains explicitly `unsupported` until its Linux proof and
  runtime enablement pass.
