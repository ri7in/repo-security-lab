# Product decision records

Product-level ADRs start here. Transfer-task decisions (D-xxx) remain in the
task's `DECISIONS.md`; entries here cover implementation choices made inside
this repository.

## ADR-001: centralized placeholder branding with a walking rename guard

**Status:** accepted (2026-08-16)

The product name is a replaceable placeholder (task decision D-067). All name
literals live in `packages/branding/src/index.ts`. A test walks the repository
and fails on any literal outside the branding source, the README allowance,
and the lockfile. Internal workspace package names use the name-free `@app/*`
scope and the root package is `workspace-root`, so no package metadata needs
renaming; published names are derived from branding at release time.

## ADR-002: dependency majors updated from the implementation plan

**Status:** accepted (2026-08-16), pending independent review

The 2026-08-16 implementation plan listed `zod ^3` and `vitest ^3` (current at
planning time). At bootstrap these were stale majors; the workspace uses the
current stable majors instead: `zod ^4`, `vitest ^4` (+ matching
`@vitest/coverage-v8`), `typescript ^5.9`, `eslint ^9` with
`typescript-eslint ^8`, `@types/node ^24` (matching the Node 24 CI target).
Schemas use the Zod 4 API (`z.strictObject`, exhaustive enum records,
`z.iso.datetime`). Vite moved from 6 to 7 and better-sqlite3 from 12 to 13;
Hono remains on 4 and its Node adapter on 2. The exact lock resolves Zod 4.4.3,
Vite 7.3.6, better-sqlite3 13.0.3, Hono 4.13.2, and the Node adapter 2.1.1.
External runtime dependencies remain limited to those three runtime families.

## ADR-003: internal packages resolve TypeScript source; no build artifact yet

**Status:** accepted (2026-08-16), revisit on measurable build/typecheck cost

Workspace packages are private and never published; their `exports` point at
`src/index.ts`. TypeScript typechecks everything through one strict root
project (`tsc -p tsconfig.json`, `noEmit`) and Vitest transforms sources
directly, so stage 1 needs no build step and no project-reference graph. The
implementation plan's project-references layout is deferred until a deployable
app or measurable typecheck cost exists; `tsconfig.base.json` already carries
the shared strict options so the migration is additive.

## ADR-004: account-level request-state vocabulary

**Status:** accepted (2026-08-16, review pass 2)

The authority contracts fix the repository state machine but never enumerate
account-level request states. `packages/contracts` uses the smallest closed
set that fits the accepted API surface:
`accepted | discovering | scanning | complete | failed`.

Confirmed semantics: `complete` is the only success terminal and means every
ledger repository reached a terminal state — even when individual
repositories ended `partial`, `failed`, or `cancelled` — because that detail
is fully expressed in the exhaustive `repositoryTotals`. A request-level
`partial` or `cancelled` state would duplicate derived information and was
deliberately rejected. `failed` means the request itself could not proceed
(discovery failure, scope rejection), never an aggregate of repository
failures.

## ADR-005: engine identity is out-of-band, never hostile-packet content

**Status:** accepted (2026-08-16, review pass 2)

The first cut of `brokerResultPacketSchema` carried `engine` as an enum field
inside the packet crossing the hostile-domain egress boundary. Review pass 2
identified this as a boundary defect: the authority threat model specifies
"one fixed engine channel", and a packet-carried engine claim — even a closed
enum — would let a compromised normalizer relabel a packet and route its
tokens through another engine's manifest.

The hostile packet now contains only `schemaVersion` and numeric
`{token, bucket}` groups. Engine identity is supplied by the receiving broker
from its per-engine channel and the lease. Any `engine` key in a packet, even
with a valid value, rejects the whole packet as an unknown field (tested).
`engine` remains only in the broker-derived hosted finding, where the broker
injects it from trusted state.

## ADR-006: progressive durable requests and generation-derived publication

**Status:** accepted (2026-08-16, Fable/Codex core review)

The control plane persists `accepted` before discovery so the API can return a
real request ID immediately. Discovery completion atomically creates the full
repository ledger (`waiting` or `empty`) and is idempotent only for an exact
ledger match. SQLite is the exercised local adapter; the Store port remains
asynchronous for a future D1 adapter, whose deployed semantics are still an
open proof gate.

Lease generation is a monotonically increasing repository field, not data
hidden inside a nullable lease. It survives release/expiry and prevents ABA.
Publication has no worker-selected idempotency string: repository identity,
immutable commit, and lease generation form the key. Exact at-least-once
retries are acknowledged before stale-lease checks; changed payloads or
generations conflict. At the three-attempt ceiling an expired row remains
nonterminal and returns the exact generation requiring cleanup.
`finalizeExhausted` uses a generation/expiry/attempt CAS and only then reports
fixed `LEASE_RETRY_EXHAUSTED`; wrong-generation finalization is tested and
rejected. Every expired generation, not only the final attempt, remains parked
and unclaimable until a janitor proves removal of its tuple-keyed scratch root.
Only then may an exact generation CAS requeue it or finalize exhaustion. This
prevents a new generation from publishing while stale source from an earlier
attempt remains on disk.

## ADR-007: guarded streaming archives and cleanup-before-publication

**Status:** accepted (2026-08-16)

Workers accept only exact-commit GitHub tarballs after a manually validated
codeload redirect. Extraction is a project-owned streaming tar.gz guard; it
rejects links, devices, sparse/unknown entries, unsafe or ambiguous paths,
invalid checksums/padding, abusive PAX metadata, and every configured size,
count, depth, or ratio limit. Broker invocation occurs only after the entire
tuple-keyed job root has been removed and verified absent. Failed cleanup leaves
the repository nonterminal in `cleaning`.

## ADR-008: real Gitleaks identity and contextual redaction

**Status:** accepted (2026-08-16), provenance gate remains open

The scanner adapter verifies the exact executable, trusted config, and ignore
file hashes before every scan, verifies version 8.30.1, and invokes without a
shell in a minimal environment. The `Secret` field must be exactly `REDACTED`.
Gitleaks may preserve non-secret expression context in `Match` (for example
`TOKEN=REDACTED`), so the adapter requires that marker but discards the entire
field inside the hostile domain. Only a pinned rule ID returns to the caller.
Release-asset hashes establish exact identity, not reproducible provenance.

## ADR-009: loopback-only composed runtime before Linux isolation

**Status:** accepted (2026-08-16)

The private composed runtime requires both requested-login and immutable
GitHub-account-ID allowlists, an exact scanner path/hash, and a loopback host.
It refuses public binding even when operator mode is off. Public third-party
scanning waits for the separate Linux isolation proof; the static web build is
not presented as a complete hosted backend.

## ADR-010: AI is an unnetworked fixture lane

**Status:** accepted (2026-08-16)

The slice exercises two distinct fixture scouts, strict candidates, local
grounding, and a fixture judge while the default state remains `ai_not_run`.
The provider vocabulary contains only `fixture`; a real adapter cannot be
registered. Provider access, source submission, and terms-dependent behavior
remain outside this authorization.

## ADR-011: MIT license for the open-source project

**Status:** accepted for the private slice (2026-08-16)

The repository uses the MIT License, matching the owner's existing open-source
project style and the standalone Gitleaks engine's permissive license. The root
package records `MIT`; contribution/security guidance and third-party notices
are committed with the source. This selection can be revisited before public
release, but the repository is no longer left in the legally ambiguous
"source visible but no permission granted" state.

## ADR-012: loopback runtime rejects DNS rebinding

**Status:** accepted (2026-08-16)

Loopback binding alone is not an owner-authentication boundary: a hostile DNS
name can resolve to `127.0.0.1` and make same-origin browser requests to a
local service. The composed runtime therefore accepts only a literal Host
header matching its configured `127.0.0.1` or `[::1]` bind (with a valid port).
The in-process app keeps this enforcement opt-in for unit embedding, while the
real server always enables it. A Vite-proxy smoke proof returned 400 through
the legitimate local host and fixed 404 for an attacker Host.

## ADR-013: specialist failure is engine-scoped

**Status:** accepted (2026-08-16, Fable/Codex review)

A repository-level reason alone cannot represent mixed scanner outcomes. The
worker therefore runs each applicable engine and its source-blind broker as an
independent lane. A lane failure records only a closed `FailureClass` under
that engine, while findings from successful lanes remain publishable. The
aggregate repository is `partial` when at least one engine succeeded and
another failed or hit its finding limit; it is `failed` only when no engine
succeeded.

The canonical reason map is stored on the repository rather than overloading
coverage rows. Its keys are the fixed scan-engine enum and its values are the
fixed failure enum, so neither scanner output nor target-controlled text can
enter durable state or anonymous responses. Publication retries compare the
canonical map for exact idempotency, and every requeue/release path clears it.
Broker engine identity remains constructor-bound and is checked again before
accepted findings join the publication.

## ADR-014: public source-blind reports require no login

**Status:** accepted (2026-08-17), replaces the owner-OAuth report gate

Coverage and finding reports are public to anyone who has a request ID. The
public finding contract is a strict broker-derived subset: engine, rule,
category, severity, confidence, occurrence bucket, remediation key, repository
ID, and commit SHA. It deliberately omits internal finding/request IDs and
owner-detail references and cannot express paths, filenames, snippets, matches,
scanner prose, or secret values. The browser uses this route directly without
an account or session.

The unused OAuth implementation and its secret binding are removed. Legacy
`/auth/` and `/api/owner/` paths return a fixed no-store 404 instead of falling
through to static assets. The full broker record remains loopback-only for
operator proofs. This report-visibility decision is separate from scan
admission: third-party scan creation stays disabled until the isolated compute
gate is satisfied.

## ADR-015: OCI Always Free is the public compute target

**Status:** accepted implementation, live provisioning pending (2026-08-17)

The continuously available $0 path is one OCI Always Free A1 Ubuntu worker.
The credentialed host process acquires exact GitHub snapshots and speaks the
signed control-plane protocol. Archive extraction and scanners run in a bundled
bubblewrap domain with no network, ambient environment, or credential mounts;
tools are read-only and output is a strict numeric result file. A startup probe
must prove no network, hidden credential paths, denied outside writes, and an
exact environment allowlist before the public-worker constructor can exist.
The prepared systemd unit adds a non-root identity, read-only host filesystem,
no capabilities or swap, and memory/CPU/task ceilings. Public admission remains
off until the owner provisions the VM and private/public synthetic gates pass.

## ADR-016: Zizmor is the next source-blind specialist

**Status:** accepted, default-off until Linux proof (2026-08-17)

Zizmor 1.29.0 is pinned by source commit plus Linux archive/binary hashes. The
adapter copies only bounded workflow YAML into a renamed staging tree, forces
offline/no-config/no-ignore regular-persona JSON mode, closes exit semantics,
and discards every description, URL, location, fix, and ignored field. Only a
reviewed 36-audit/61-variant offline numeric vocabulary crosses the broker. The
four upstream audits documented as online-only are explicitly excluded. Multiple
severity/confidence variants for one audit are legal in the manifest, but two
variants for one audit in one packet reject. OSV and Opengrep remain deferred
until their offline database/rules, memory, provenance, and Linux gates pass.

## ADR-017: no-domain email is an optional encrypted one-shot queue

**Status:** accepted implementation, owner setup pending (2026-08-17)

Scanning and report viewing never depend on email. During the private preview,
four notification secrets bind the queue to one operator-controlled address.
The address is encrypted with AES-GCM, one recipient and 80 total messages per
rolling day are enforced in code and D1, and delivery starts only after a
request is terminal. The fixed HMAC-signed relay carries one recipient and
public report URL. Apps Script persists a bounded replay marker before MailApp,
choosing best-effort at-most-once delivery across lost responses. Its
100-recipient consumer quota leaves a 20-message reserve. Ciphertext and IV are
erased after success or final failure. Public scanning structurally disables
email until recipient consent can be verified. Resend remains dormant because
its test domain cannot deliver arbitrary recipients.

## ADR-018: public reports have bounded reads and 30-day retention

**Status:** accepted (2026-08-17)

Summary polling uses ETags and a three-second backoff; active scans fetch at
most the first 100 ledger rows, while terminal reports paginate the complete
ledger. Public reads have a dedicated edge rate limit. A budget-reserved cron
task first terminalizes one active request abandoned for 24 hours, invalidates
its leases, and erases queued recipient ciphertext. A second budget-reserved
task deletes one terminal request older than 30 days, cascading to ledgers,
findings, reservations, and notification metadata. The site exposes the last
update plus plain privacy and acceptable-use pages. Scan admission closes at
40,000 modeled writes per UTC day; privacy maintenance can reserve through
60,000, leaving 40% of the D1 Free daily allowance for indexes and other
unmodeled writes. Global admission is capped at 240 requests per UTC day, below
the 288-per-day purge and stale-expiry throughput of the five-minute cron, so
sustained accepted intake cannot outrun cleanup. Cron runs privacy maintenance
before recovery, which is bounded to three requests per invocation to remain
below D1's 50-query cap.
