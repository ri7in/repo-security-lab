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
- `packages/github` — complete public-repository discovery and exact-commit
  archive acquisition with redirect, size, pacing, and timeout guards.
- `packages/archive` — streaming hostile tar.gz validation and private-mode
  extraction without executing repository content.
- `packages/scanners` — verified Gitleaks adapter plus explicit fail-closed
  placeholders for specialists that are not integrated yet.
- `packages/normalize` and `packages/broker` — the hostile-domain numeric
  result encoder and source-blind trusted decoder.
- `packages/worker` — lease-bound fetch, guard, scan, cleanup, broker, publish,
  and stale-generation janitor flow.
- `packages/ai` — disabled-by-default two-scout fixture and grounding harness;
  no external model adapter.
- `apps/api` — Hono control plane and loopback-only private runtime.
- `apps/web` — responsive vanilla TypeScript report interface.
- `docs/` — architecture, maintenance, and decision records.

## Development

Requires Node >= 24 and pnpm.

```sh
pnpm install
pnpm check   # typecheck + lint + tests
pnpm build   # production web bundle
```

The private local runtime requires an immutable GitHub account allowlist and
the exact verified Gitleaks binary identity. It refuses non-loopback binding:

```sh
PRIVATE_SLICE_ACCOUNT_IDS=121791882 \
GITHUB_TOKEN="$(gh auth token)" \
GITLEAKS_BINARY=/absolute/path/to/gitleaks \
GITLEAKS_SHA256=<64-lowercase-hex-digest> \
OPERATOR_MODE=true \
pnpm dev:api

# In a second terminal; Vite proxies /api to the loopback runtime.
pnpm dev:web
```

This is a private proof, not a public deployment. Third-party accounts remain
refused until the documented Linux isolation gate passes.
`OPERATOR_MODE=true` enables the source-blind findings table only on loopback;
without it, the browser receives coverage/status and the findings route is
absent.
