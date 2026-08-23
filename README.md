# repo-security-lab

> **Placeholder name.** `repo-security-lab` is a replaceable development
> placeholder (decision D-067); the final product name is still owned by the
> project owner. All branding lives in `packages/branding` and renaming is
> mechanical — see `docs/maintenance.md`.

Zero-cost, privacy-preserving security reports for all public
repositories of a GitHub account. A visitor enters a GitHub username; a
backend agent system attempts every owned public repository and returns one
clear combined report with exact per-repository, per-specialist coverage.

**Live and open.** The website and D1 control plane are live at
[repo-security-lab.rivinsand.workers.dev](https://repo-security-lab.rivinsand.workers.dev).
Public scanning is live: anyone can scan any public GitHub account, with no
sign-up, and the pull worker runs on GitHub Actions under enforced Bubblewrap
isolation. The AI code review is on, and it calls OpenRouter, Groq and Google.
Current guarantees:

- Target repository code is treated as hostile data and is **never executed** —
  no dependencies, scripts, tests, builds, or hooks of scanned repositories run.
- A scanner finding is deleted only when every judge on the council rejects it,
  and the council is two models from different families. Fewer than two judges,
  two of one family, an exhausted quota, a provider timing out, a partly
  reviewed repository or any thrown error all keep the finding. No model
  declares a repository safe; the verdict is computed from coverage.
- The evidence channel out of the sandbox carries no archive-derived strings:
  only manifest-issued numeric tokens and four count-bucket codes cross the
  source-blind broker. Locations travel separately and deliberately: a
  validated relative path and a line number, capped per finding, with traversal
  and absolute paths refused at the source. Matches, snippets and secret values
  are on neither channel.
- Gitleaks and Zizmor have exact version/hash pins, strict adapters, and
  source-blind manifests. Zizmor remains runtime-default-off outside the Linux
  scan domain and cannot silently claim coverage.
- Report email is off. If it is ever switched on it uses an encrypted one-shot
  queue, and public scanning keeps it disabled until a recipient-consent flow
  exists.
- Abandoned active reports fail after 24 hours, and terminal reports expire 30
  days after their last update; privacy and acceptable-use policies ship with
  the site.
- Global admission is capped at 240 reports per UTC day, below the 288/day
  retention drain. Scan admission stops at 40% of the D1 Free allowance;
  privacy maintenance has a protected band up to 60%.
- The AI pass sends public source code to model providers. A reader on
  OpenRouter takes whole source files with every secret-scanner line blanked
  first. Separately, a twelve line excerpt around each secret-scanner finding
  goes to Groq and to Google, so two models from different families can vote on
  whether it is a false alarm. Providers may keep or train on what they
  receive, which is what pays for the free tier, and the site says so.
  `AI_REVIEW_ENABLED=false` stops both.
- A model can delete a secret-scan finding, but only when every judge rejects
  it. Fewer than two judges, two of one family, an exhausted quota, a provider
  timing out, a partly reviewed repository or any thrown error all keep the
  finding, because showing a false positive is far cheaper than deleting a
  real one.
- A model cannot write into a report. It picks one of ten weakness classes, and
  every word a reader sees, the rule name and the remediation included, is
  looked up from that class in a fixed manifest. The severity is that class's
  fixed rating, so a reader that mislabels the class shifts the severity with
  it; no judge is asked whether the class fits, only whether the finding is
  real.
- Forks are not scanned. Owning a fork does not make its upstream source
  yours, and the ledger says so rather than hiding the row.

## Layout

- `packages/branding` — the only place the product name exists; guarded by a test.
- `packages/contracts` — versioned Zod schemas and types for states, coverage,
  failure classes, API DTOs, source-blind broker primitives, and AI tagging.
- `packages/core` — state graph, scheduler, complete-ledger aggregation, and
  the portable durable Store contract.
- `packages/store-sqlite` — exercised STRICT SQLite adapter with atomic leases,
  generation-based stale rejection, and idempotent publication.
- `packages/store-d1` — workerd-tested D1 adapter with atomic complete-ledger
  installation, materialized totals, bounded finding chunks, and a conservative
  daily free-tier write reserve.
- `packages/worker-protocol` and `packages/store-http` — rotating,
  generation-bound HMAC worker transport with bounded bodies and server time.
- `packages/github` — complete public-repository discovery and exact-commit
  archive acquisition with redirect, size, pacing, and timeout guards.
- `packages/archive` — streaming hostile tar.gz validation and private-mode
  extraction without executing repository content.
- `packages/scanners` — verified Gitleaks and Zizmor adapters plus explicit
  fail-closed placeholders for specialists that are not integrated yet.
- `packages/normalize` and `packages/broker` — the hostile-domain numeric
  result encoder and source-blind trusted decoder.
- `packages/worker` — lease-bound fetch, guard, scan, cleanup, broker, publish,
  and stale-generation janitor flow.
- `packages/ai` — the two-pass funnel: a reader, a deterministic grounding
  gate no model takes part in, and a judge council of distinct model families.
  `packages/ai-providers` is the external model adapter.
- `apps/api` — Hono control plane and loopback-only private runtime.
- `apps/control-plane` — Cloudflare Workers, D1, Static Assets, rate limiting,
  cron recovery, public source-blind reports, and the signed worker API.
- `apps/scan-worker` — external pull worker for trusted private-slice compute.
- `apps/scan-domain` — bundled credential-free extraction/scanning process with
  a strict numeric result contract.
- `apps/web` — responsive vanilla TypeScript report interface.
- `deploy/oci` — ARM64 Always Free bootstrap, hardened systemd service, and
  local-to-host deployment runbook.
- `integrations/google-apps-script` — optional no-domain report-email relay.
- `docs/` — architecture, threat model, research record, maintenance,
  decisions, and private-slice retrospective.

## Development

Requires Node >= 24 and pnpm.

```sh
pnpm install
pnpm check                 # typecheck + lint + Node and workerd tests
pnpm test:coverage         # enforced Node coverage floor
pnpm build:all             # scan-domain/worker + production Worker bundles
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

The checked-in Cloudflare config is fail-closed on purpose
(`PUBLIC_SCANNING_ENABLED=false`), so a fresh clone cannot open the service by
accident; `deploy/redeploy.sh` passes the flags the live service runs with. D1 is provisioned and migrated in APAC, the
preview is bound to GitHub account ID `121791882`, and static/API responses pass
through the same security-header boundary. The dedicated discovery credential,
signed worker identity, and first 22-repository live proof are installed. The
finding report is public and requires no login. It names the file and line of
each match so a finding can be acted on. It cannot express snippets, matches,
secret values, or internal detail references. The
remaining release gate is provisioning the prepared continuously available,
terms-compatible OCI worker and passing its exact Linux proof, so third-party
scan creation stays refused until that compute boundary passes. See
`docs/maintenance.md` and `deploy/oci/README.md` for the release runbook.
`OPERATOR_MODE=true` additionally enables the full broker record on loopback;
the public browser receives only the reduced public finding schema.
