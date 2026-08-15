# repo-security-lab

> **Placeholder name.** `repo-security-lab` is a replaceable development
> placeholder (decision D-067); the final product name is still owned by the
> project owner. All branding lives in `packages/branding` and renaming is
> mechanical — see `docs/maintenance.md`.

Free, open-source, privacy-preserving security reports for all public
repositories of a GitHub account. A visitor enters a GitHub username; a
backend agent system attempts every owned public repository and returns one
clear combined report with exact per-repository, per-specialist coverage.

**Private development slice.** This repository is under private development
and is not a released product. Current guarantees of the design:

- Target repository code is treated as hostile data and is **never executed** —
  no dependencies, scripts, tests, builds, or hooks of scanned repositories run.
- Deterministic findings are immutable evidence; AI may never suppress them or
  declare a repository safe.
- Hosted scan egress carries no archive-derived strings: only manifest-issued
  numeric tokens and four count-bucket codes cross the source-blind broker.
- The AI lane currently exists only as typed contracts and deterministic
  fixture tagging. No model client exists in the dependency graph, and no
  repository byte can reach any model.
- Until enforced Linux isolation passes, scans are structurally refused for
  accounts outside the private-slice allowlist (`PRIVATE_SLICE_SCOPE`).

## Layout

- `packages/branding` — the only place the product name exists; guarded by a test.
- `packages/contracts` — versioned Zod schemas and types for states, coverage,
  failure classes, API DTOs, source-blind broker primitives, and AI tagging.
- `packages/core` — state graph, scheduler, complete-ledger aggregation, and
  the portable durable Store contract.
- `packages/store-sqlite` — exercised STRICT SQLite adapter with atomic leases,
  generation-based stale rejection, and idempotent publication.
- `docs/` — architecture, maintenance, and decision records.

## Development

Requires Node >= 24 and pnpm.

```sh
pnpm install
pnpm check   # typecheck + lint + tests
```
