# Architecture

**Status:** private vertical slice, stage 2 (contracts, durable core, local store).
This document grows with each implemented stage; the complete accepted
architecture lives in the transfer task's authority documents until the
research import stage copies them into `docs/research/`.

## Product shape

A visitor enters a GitHub username on the website. The backend control plane
creates a durable request and a complete ledger of every owned public
repository from live GitHub discovery. Local trusted workers claim leases,
fetch immutable-commit archives, guard and extract them safely, run pinned
deterministic scanners with trusted configuration, normalize results, destroy
source, and upload broker-validated results. The browser is the interface and
report viewer only; it never downloads repositories or scans anything.

## Non-negotiable boundaries (implemented progressively)

1. **No target code execution.** Scanned repository content is hostile data.
   No dependency install, script, test, build, Dockerfile, Makefile, or hook
   of a target repository ever runs.
2. **Source-blind hosted egress.** The hostile normalization domain may emit
   only manifest-issued numeric tokens plus four count-bucket codes (integer
   0..3), at most 256 unique groups per engine and repository. Engine
   identity is fixed out-of-band by the broker-owned per-engine channel and
   the lease; the hostile packet carries no engine field, so a compromised
   normalizer cannot relabel a packet onto another engine's manifest
   (ADR-005). A source-blind broker maps tokens through pinned trusted
   manifests, derives all metadata, injects lease identity, and rejects whole
   results on any violation with fixed non-echoing reasons. No
   archive-derived string can cross.
3. **Immutable deterministic evidence.** Scanner findings are never
   suppressed, downgraded, or overridden by AI.
4. **AI is typed and inert in this slice.** The contracts define provider
   policies, review tiers, and deterministic fixture tagging
   (`provider: "fixture"`). No network provider adapter exists; production
   mode reports `ai_not_run`.
5. **Private-slice scope.** Until enforced Linux isolation passes, the control
   plane structurally refuses usernames outside the allowlist with the fixed
   failure class `PRIVATE_SLICE_SCOPE`.
6. **Anonymous output is status/coverage only.** The anonymous API schemas
   cannot express finding data; findings are owner-gated (operator mode now,
   no-scope OAuth later).

## Contracts package (implemented)

`packages/contracts` is the single vocabulary for every later package:

- **Repository states:** `discovered → waiting → leased → acquiring →
  guarding → scanning → normalizing → cleaning → uploading →
  waiting_to_publish → complete`, terminals `empty | partial | failed |
  cancelled`.
- **Request states:** `accepted | discovering | scanning | complete | failed`
  (ADR-004, confirmed in review pass 2). `complete` means every ledger
  repository reached a terminal state; per-repository `partial`/`failed`/
  `cancelled` detail lives in the repository totals. `failed` means the
  request itself could not proceed.
- **Specialist coverage:** the five terminal coverage outcomes `complete |
  not_applicable | unsupported | partial | failed`
  (`specialistCoverageOutcomeSchema`); the progressive status API adds
  `waiting` as a separate progress-state vocabulary
  (`specialistProgressStateSchema`) — `waiting` is never a coverage outcome.
  Specialists are `snapshot`, `archive_guard`, `gitleaks`, `osv`, `zizmor`,
  `opengrep`.
- **AI lane states:** `ai_not_run | ai_waiting | ai_partial`.
- **Failure classes:** the accepted fixed classes plus
  `PRIVATE_SLICE_SCOPE` and `LEASE_RETRY_EXHAUSTED` (ADR-006).
- **Broker primitives:** numeric manifest tokens, count-bucket codes 0..3 with
  fixed labels, strict engine-free result packets (schemaVersion plus
  token/bucket groups only; 256-group ceiling, unique tokens, unknown keys —
  including any `engine` claim — rejected), and the closed `schema_version 1`
  broker-derived finding shape, where `engine` is broker-injected from the
  channel/lease.
- **API DTOs:** create/summary/repository-page schemas that are strict,
  bounded, and structurally unable to carry findings, paths, snippets, or
  free-form text. Identifier grammars (GitHub login/repository name) validate
  control-plane data only.
- **AI tagging:** closed provider vocabulary containing only `fixture`,
  modes `disabled | fixture` (default `disabled`), review tiers, and typed
  provider policies with a required-ZDR flag.

Schemas are Zod validators with inferred types; consumers validate at runtime
at every boundary, not only at compile time.

## Durable core and local store (implemented)

`packages/core` owns the storage-neutral state graph, complete-ledger
aggregation, deterministic scheduling, lease/publication types, and the
asynchronous Store port shared by local SQLite and the future D1 adapter.
Every ordinary worker mutation is bound to `(requestId, repositoryId,
workerId, leaseGeneration)`; terminal outcomes use a separate publication
operation that requires a fixed reason where applicable and six real coverage
outcomes (never `waiting`).

The progressive lifecycle is durable rather than simulated: a request is
created as `accepted` before the `202` response, moves to `discovering`, then
`completeDiscovery` atomically installs the complete owned-repository ledger
and marks each row `waiting` or `empty`. Retrying the same ledger is
idempotent; a different ledger conflicts. Request-level discovery failure uses
one fixed failure class. `discovered` remains the logical discovery output,
not a separately committed row between that atomic operation and `waiting`.

`packages/store-sqlite` is the real local adapter. It uses
better-sqlite3 13.0.3, versioned STRICT tables, normalized coverage rows, and
a D1-compatible SQL subset for shared queries. Local transaction wrappers are
explicitly adapter-specific and are not presented as deployed D1 proof. A
single conditional `UPDATE ... RETURNING` claims work in stable order and
increments a durable generation that is never reset when the lease is
cleared. Failed/terminal requests cannot be claimed.

Publication identity is not worker-supplied text: it derives from the durable
repository/commit plus lease generation. Same-generation, same-payload retry
is acknowledged before stale-lease checks; changed metadata or generation
conflicts. Lease release and expiry preserve the generation. At the attempt
ceiling an expired job parks nonterminal and returns its exact generation to
the janitor; only an exact-generation CAS after that scratch root is removed
can finalize fixed `LEASE_RETRY_EXHAUSTED`. This two-phase store gate is
implemented and tested. The worker janitor/filesystem proof itself lands with
the worker slice; no third-party scan may rely on the local boundary.

## Toolchain

pnpm workspaces, strict TypeScript (shared `tsconfig.base.json`), ESLint flat
config with type-checked rules, Vitest, and better-sqlite3 for the isolated
local store package. Node 24 is the CI target; Node 25 is
tolerated locally. Internal packages resolve TypeScript source directly
(`exports` → `src/index.ts`); they are private and never published, so no
build artifact exists yet. A build/reference setup lands when the first
deployable app appears (see `docs/decisions.md`).
