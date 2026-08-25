# Maintenance

## Product rename runbook

The product currently uses a replaceable placeholder name. Every name literal
is centralized in `packages/branding/src/index.ts` and enforced by the rename
guard test in `packages/branding/test/branding-guard.test.ts`, which walks
every text file in the repository (known text extensions/basenames; binary
fixtures are skipped, and the test asserts its own scan set is non-vacuous)
and fails if the slug or display name literal appears anywhere except:

1. `packages/branding/src/index.ts` (the single branding source),
2. `README.md` (explicit README allowance),
3. `pnpm-lock.yaml` (lock metadata, only if ever unavoidable).
4. `apps/control-plane/wrangler.jsonc` (Cloudflare Worker, D1, and live-origin
   resource names, which cannot import the TypeScript branding module).

To rename the product:

1. Edit `productSlug`, `productDisplayName`, `tagline`, `description`, and
   `repoUrl` in `packages/branding/src/index.ts`.
2. Update the name in `README.md`, and the live URL in
   `SECURITY.md` and `CONTRIBUTING.md`. Those three are the only files outside
   `packages/branding` allowed to hold the name, and the rename guard's
   allowlist is the list of them.
3. Rename the local project directory to the new slug.
4. Rename the GitHub repository (`gh repo rename <new-slug>`). The repository slug is the one
   unavoidable external use of the name.
5. Run `pnpm check`; the rename guard reads the current branding values, so it
   verifies the new name automatically and fails on any leftover literal.
6. When packages are ever published, take npm package names from the branding
   slug at release time; internal workspace names (`@app/*`) are deliberately
   name-free and never need renaming.

## Toolchain policy

- **Node:** CI targets Node 24 (current LTS). Node 25 (non-LTS) is tolerated
  for local development; any 25-only behavior difference must be caught before
  it reaches CI assumptions.
- **pnpm:** pinned via the `packageManager` field in the root `package.json`.
- **Dependencies:** lean by policy. External runtime dependencies are Zod for
  strict contracts, Hono plus its Node adapter for the private API, and
  better-sqlite3 inside the local-store package. Everything else is dev
  tooling. better-sqlite3 13.0.3 embeds the supported platform prebuilds in
  the integrity-locked npm artifact, so pnpm's blocked lifecycle scripts are
  not approved or required. Dependency majors track the current stable
  release compatible with Node 24; version adjustments against the original
  implementation plan are recorded in `docs/decisions.md`.

## Verification commands

```sh
pnpm install          # resolves/checks the committed lockfile
pnpm typecheck        # strict TypeScript over all packages and tests
pnpm lint             # ESLint flat config, type-checked rules
pnpm test             # Vitest, includes the rename guard and contract suites
pnpm test:workers     # workerd-backed Worker, D1, and internal API tests
pnpm test:coverage    # same suite plus the enforced aggregate coverage floor
pnpm check            # all of the above
pnpm build            # production web bundle
pnpm build:control-plane # Cloudflare Worker dry-run bundle and binding check
pnpm build:all         # scan-domain, scan-worker, and control-plane bundles
```

Before a control-plane release, also apply the D1 migration to a fresh local
database and build the Worker from the committed tree:

```sh
proof_dir="$(mktemp -d)"
pnpm exec wrangler d1 migrations apply DB --local \
  --config apps/control-plane/wrangler.jsonc --persist-to "$proof_dir"
pnpm build:control-plane
```

The deployment URL is published in `README.md`. D1 is migrated, and the
deployed service runs with public scanning on, set by `deploy/redeploy.sh`
rather than by the checked-in config, which stays fail-closed so that a clone
cannot open a service by accident.

Always deploy with `deploy/redeploy.sh`. It applies pending D1 migrations,
passes the flags the live service runs with, and refuses to finish unless
`/api/capabilities` reports public scanning and the served bundle hash matches
the one just built. A bare `wrangler deploy` replaces the deployed variables
with the fail-closed set and takes the service down to nobody: public scanning
turns off and the worker dispatch unhooks, silently.

Reports require no OAuth application or login;
legacy auth and owner routes return fixed 404 responses. Install service
credentials only through Wrangler secrets; never commit them. The trusted scan
worker uses the signed internal protocol, and the current implementation is not
a public multi-tenant sandbox.

The dedicated public-data discovery token, worker-auth master secret, and
generation-1 `worker_github_actions_01` identity are installed as Wrangler
secrets. The scan workflow has no schedule: it is dispatched on request
creation and by the five-minute cron, and only when work is actually waiting.
GitHub's current Actions terms
warn against using hosted Actions as part of a serverless application, so it is
not the continuous production compute boundary.

CI additionally downloads the exact SHA-256-pinned zizmor 1.29.0 release and
audits this repository's workflow/config definitions offline with target
configuration and ignores disabled. A clean JSON-v1 array is required. The
hosted source-blind adapter is implemented and may run only inside the proven
Linux scan domain. Its `complete` state means all 36 allowlisted offline audits
ran; `impostor-commit`, `known-vulnerable-actions`, `ref-confusion`, and
`stale-action-refs` are excluded because upstream marks them online-only.

The name-only applicability walk intentionally treats a stemless `.yml` or
`.yaml` entry directly under `.github/workflows/` as workflow-relevant. This
conservative bias can only produce `unsupported`; it cannot produce a false
absence or a claim that the offline workflow lane ran.

CI also downloads the provenance-checked, exact SHA-256-pinned OSV-Scanner
2.5.0 binary and scans only this project's committed `pnpm-lock.yaml`, with
dependency resolution disabled. Its JSON report must contain zero vulnerable
result groups. This CI hygiene check uses the public OSV lookup for the
project-owned dependency graph; hosted target scanning remains disabled until
the separate offline-database trust design is implemented.

The real-binary end-to-end privacy proof is opt-in locally and mandatory in
CI:

```sh
RUN_GITLEAKS_E2E=1 \
GITLEAKS_BINARY=/absolute/path/to/gitleaks \
GITLEAKS_SHA256=<verified-binary-sha256> \
pnpm vitest run apps/api/test/e2e.test.ts
```

The store smoke test must resolve from its owning workspace package:

```sh
cd packages/store-sqlite
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.exec('SELECT 1'); db.close()"
```

## CI and scanner pin renewal

The workflow pins GitHub Actions to full commit SHAs and Gitleaks to both the
official release-archive SHA-256 and extracted-binary SHA-256. Upgrades require:

1. Resolve action tags through the GitHub commits API and record the resulting
   full SHAs; never copy an unverified floating tag into the workflow.
2. Download the Gitleaks checksum file and platform archive from the official
   release, verify the checksum file's entry, extract into a private temporary
   directory, and independently hash the binary.
3. Update the adapter vocabulary/config provenance record if the rule set
   changes; rule-token order is a hosted data contract.
4. Run `pnpm check`, the real-binary e2e proof, `pnpm build`, and a redacted
   self-scan before committing.
5. Treat the release hash as identity only. Public release still requires the
   project-attested/reproducible-build gate documented in the architecture.

## Local private runtime

The runtime writes only under `.data/` by default, which is gitignored. It
requires `PRIVATE_SLICE_ACCOUNT_IDS`, `GITLEAKS_BINARY`, and
`GITLEAKS_SHA256`; `PRIVATE_SLICE_LOGINS` defaults to the operator username.
Set `GITHUB_TOKEN` for efficient GraphQL discovery. `OPERATOR_MODE=true` adds
the finding endpoint but is accepted only on loopback. Stop the process cleanly
with SIGINT/SIGTERM so the SQLite handle closes; startup cleanup removes any
tuple-keyed scratch directories left by a prior interrupted private run. The
database parent must already be private or be safely creatable as mode `0700`;
the runtime rejects permissive and symlinked parents instead of changing them.
It also holds SQLite in exclusive locking mode, so a second local runtime fails
promptly rather than sharing lease ownership.

A crash tuple is deleted on the next startup, before the API listens. Its
durable row remains parked until the old lease expires, so recovery can wait up
to the configured 20-minute lease duration before the janitor requeues or
finalizes it. Immediate startup lease adoption is intentionally deferred until
that separate recovery protocol has its own exact-generation proof.

Live GitHub rate-limit and transport failures are retried only after verified
scratch cleanup, with a closed three-attempt budget. The private low-volume
slice does not yet schedule backoff; Retry-After-aware `next_eligible_at`
scheduling belongs to the phase-three queue adapter before public operation.

## Public Linux worker

The selected $0 compute target and exact owner handoff live in
`deploy/oci/README.md`. Build artifacts contain no credentials. The deployment
script transfers only the two bundles, trusted scanner configs, and bootstrap
files; the VM downloads exact SHA-256-pinned ARM64 Node, Gitleaks, and Zizmor
artifacts. Bootstrap deliberately leaves the service disabled.

Public enablement is two separate switches: `PUBLIC_WORKER=true` on the OCI
host, then `PUBLIC_SCANNING_ENABLED=true` in Cloudflare. Never change both at
once. First prove an operator-only synthetic request, empty scratch, the startup
escape probe, service restart cleanup, and exact source-blind findings. Then
prove a public synthetic request before changing the control-plane switch.

CI installs bubblewrap and runs the same built scan-domain with planted source,
Gitleaks, and Zizmor. A green CI proof is necessary but does not replace the
live OCI proof.

Ubuntu 24.04 also requires its packaged `bwrap-userns-restrict` AppArmor
profile. CI and `deploy/oci/bootstrap-ubuntu.sh` install and load that narrow
profile. Never work around a missing profile by disabling the host-wide
`kernel.apparmor_restrict_unprivileged_userns` setting.

## Optional report email and retention

The no-domain owner setup is in `integrations/google-apps-script/README.md`.
Email remains absent from `/api/capabilities` and hidden in the browser unless
all four notification secrets are present. It is restricted to the configured
operator-controlled recipient and turns off when `PUBLIC_SCANNING_ENABLED=true`
until a separate consent-verification flow ships. Apply D1 migrations `0002`,
`0003`, and `0004` before deploying the code. Migration `0002` adds the encrypted
queue and hard rolling quota trigger; `0003` indexes terminal report expiry;
`0004` closes scan admission at 40,000 modeled writes per UTC day, reserves a
protected privacy-maintenance band through 60,000, preserves the final 40% for
indexes and unmodeled writes, and caps accepted reports at 240 per UTC day so
intake remains below the 288/day cleanup rate. Each cron runs privacy cleanup
first, attempts one notification, then recovers at most three discovery requests
to stay below D1's 50-query invocation ceiling.

After enabling email, send only a test address controlled by the operator,
prove the report reaches terminal state, confirm one message, and query D1 to
verify `recipient_ciphertext` and `recipient_iv` are empty. Never log or paste a
real recipient address while debugging.
