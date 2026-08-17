# Private-slice retrospective

**Status:** implementation checkpoint, not a public-release retrospective.

## What the slice proved

The project now has one real vertical path from username submission through
complete GitHub discovery, durable coverage rows, exact immutable archives,
guarded extraction, verified Gitleaks execution, source-blind normalization,
cleanup-gated publication, and a progressive report. The operator's live
account produced 22 explicit terminal rows in about 66.6 seconds: 16 complete,
four forks refused before download, and two archives stopped by the configured
size limit. Three rule groups reached the owner view without raw secret values,
paths, snippets, or match text.

The local control-plane shape also handled a synthetic 5,000-repository ledger
with 30,000 coverage rows and stable cursor pagination. This is useful evidence
for schema and scheduling choices, but it is deliberately not described as
deployed queue or scanner-throughput proof.

## Corrections that materially improved the design

- Scanner redaction still left contextual text in `Match`; the adapter was
  corrected to validate redaction and discard that field rather than assume it
  would equal the literal redaction marker.
- Engine identity was removed from hostile packets and bound to the broker
  instance. Otherwise a compromised normalizer could relabel numeric tokens.
- Lease exhaustion became a two-phase janitor operation. Later review also
  found retryable expired work becoming claimable before stale scratch cleanup;
  rows now stay parked until removal plus an exact generation/expiry CAS.
- Direct release was restricted to pre-source leases, closing a cleanup bypass
  for acquiring/scanning work.
- Fork ownership was separated from source authorship. Forks stay visible in
  the ledger but are refused before download in this private macOS slice.
- The local operator route gained literal-loopback Host validation after DNS
  rebinding was identified as a realistic way to reach a loopback service from
  a browser.
- The final report summary was corrected to count cancelled rows as needing
  attention, and CI was extended from a tree-only secret scan to both the exact
  tree and full Git history.

## Historical pre-hardening checkpoint (2026-08-15)

The following numbers are retained as the dated evidence recorded at that
checkpoint; they are not the current gate.

- Strict TypeScript and type-aware ESLint pass.
- 20 ordinary test files and 152 tests pass; six live/real/load proofs are
  explicit opt-ins.
- Aggregate coverage passes at 74.10% statements, 72.99% branches, 75.92%
  functions, and 76.80% lines.
- The opt-in e2e uses the exact hash-verified Gitleaks binary and searches raw
  SQLite, API bodies, fixed logs, and scratch state for a synthetic secret,
  source marker, and every eight-character window of both.
- A frozen scripts-disabled install in a fresh temporary copy, the native
  SQLite tests, production web build, real-binary e2e, dependency audit, and
  exact tree/history secret scans pass.

## Current hardening gate (2026-08-16)

- 22 ordinary test files and 169 tests pass; six live/real/load proofs remain
  explicit opt-ins.
- Aggregate coverage passes the raised floor at 75.05% statements, 74.05%
  branches, 77.09% functions, and 77.47% lines.
- Version five migrates populated version-four ledgers without losing active,
  leased, terminal, published, coverage, or finding rows and recreates every
  claim/lease/active-request index.
- Transient GitHub failures retry only after exact-generation scratch cleanup,
  for a maximum of three attempts. Authentication and archive-safety failures
  remain immediate terminal outcomes with fixed honest causes.
- A composed runtime-start test proves private database/scratch creation,
  exclusive SQLite ownership, service startup, and clean shutdown. A static
  first-party dependency test also keeps normalization, broker, AI, archive,
  scanner, and worker source paths free of undeclared network capability.

## What remains deliberately unclaimed

This slice does not prove public Linux isolation, deployed D1/queue behavior,
public abuse resistance, scanner reproducibility, dependency/
workflow/source-rule specialists, or real AI vulnerability detection. The
frontend is buildable but has not been deployed because the available Vercel
session could not be positively identified as the owner's personal account.
Those are release gates, not details to hide behind optimistic wording.
