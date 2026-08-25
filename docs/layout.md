# Repository layout

Internal workspace names are `@app/*` and deliberately carry no product name,
so renaming the product never touches them.

## Packages

- `packages/branding`: the only place the product name exists; guarded by a
  test that walks every text file in the repository.
- `packages/contracts`: versioned Zod schemas and types for states, coverage,
  failure classes, API DTOs, source-blind broker primitives, and AI tagging.
- `packages/core`: state graph, scheduler, complete-ledger aggregation, and the
  portable durable Store contract.
- `packages/store-sqlite`: STRICT SQLite adapter with atomic leases,
  generation-based stale rejection, and idempotent publication.
- `packages/store-d1`: workerd-tested D1 adapter with atomic complete-ledger
  installation, materialized totals, bounded finding chunks, and a conservative
  daily free-tier write reserve.
- `packages/worker-protocol` and `packages/store-http`: rotating,
  generation-bound HMAC worker transport with bounded bodies and server time.
- `packages/github`: complete public-repository discovery and exact-commit
  archive acquisition with redirect, size, pacing, and timeout guards.
- `packages/archive`: streaming hostile tar.gz validation and private-mode
  extraction without executing repository content.
- `packages/scanners`: verified Gitleaks and Zizmor adapters plus explicit
  fail-closed placeholders for specialists that are not integrated yet.
- `packages/normalize` and `packages/broker`: the hostile-domain numeric result
  encoder and the source-blind trusted decoder.
- `packages/worker`: lease-bound fetch, guard, scan, cleanup, broker, publish,
  and stale-generation janitor flow.
- `packages/ai`: the two-pass funnel: a reader, a deterministic grounding gate
  no model takes part in, and a judge council of distinct model families.
- `packages/ai-providers`: the external model adapters.
- `packages/quota`: per-provider free-tier allowances and the deep-read budget.

## Applications

- `apps/api`: Hono control plane and loopback-only private runtime.
- `apps/control-plane`: Cloudflare Workers, D1, Static Assets, rate limiting,
  cron recovery, public source-blind reports, and the signed worker API.
- `apps/scan-worker`: the external pull worker that drains the scan queue.
- `apps/scan-domain`: bundled credential-free extraction and scanning process
  with a strict numeric result contract.
- `apps/web`: responsive vanilla TypeScript report interface.

## Everything else

- `deploy/`: the deploy script, plus an ARM64 Always Free bootstrap, hardened
  systemd service, and local-to-host runbook under `deploy/oci`.
- `integrations/google-apps-script`: optional no-domain report-email relay.
- `docs/`: architecture, threat model, guarantees, research record,
  maintenance, and decision records.
