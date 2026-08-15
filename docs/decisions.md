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
`z.iso.datetime`). Runtime dependencies remain Zod only.

## ADR-003: internal packages resolve TypeScript source; no build artifact yet

**Status:** accepted (2026-08-16), revisit when the first app lands

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
rejected. The worker slice must key scratch roots by the same tuple and invoke
finalization only after removal; filesystem enforcement is not claimed by the
store alone.

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
