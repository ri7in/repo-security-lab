# Maintenance

## Product rename runbook (D-067 → D-020)

The product currently uses a replaceable placeholder name. Every name literal
is centralized in `packages/branding/src/index.ts` and enforced by the rename
guard test in `packages/branding/test/branding-guard.test.ts`, which walks
every text file in the repository (known text extensions/basenames; binary
fixtures are skipped, and the test asserts its own scan set is non-vacuous)
and fails if the slug or display name literal appears anywhere except:

1. `packages/branding/src/index.ts` (the single branding source),
2. `README.md` (explicit README allowance),
3. `pnpm-lock.yaml` (lock metadata, only if ever unavoidable).

To rename the product:

1. Edit `productSlug`, `productDisplayName`, `tagline`, `description`, and
   `repoUrl` in `packages/branding/src/index.ts`; set
   `isPlaceholderName: false` once the final name is chosen.
2. Update the name and placeholder note in `README.md`.
3. Rename the local project directory to the new slug.
4. Rename the GitHub repository (`gh repo rename <new-slug>`) — the repository
   slug is the one unavoidable external use of the name.
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
- **Dependencies:** lean by policy. Runtime dependencies are Zod in contracts
  and better-sqlite3 inside the local-store package only; everything else is
  dev tooling. better-sqlite3 13.0.3 ships the supported platform prebuilds,
  so pnpm's blocked lifecycle scripts are not approved or required. Dependency majors track
  the current stable release compatible with Node 24; version adjustments
  against the original implementation plan are recorded in
  `docs/decisions.md`.

## Verification commands

```sh
pnpm install          # resolves/checks the committed lockfile
pnpm typecheck        # strict TypeScript over all packages and tests
pnpm lint             # ESLint flat config, type-checked rules
pnpm test             # Vitest, includes the rename guard and contract suites
pnpm test:coverage    # same suite plus the enforced aggregate coverage floor
pnpm check            # all of the above
pnpm build            # production web bundle
```

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
tuple-keyed scratch directories left by a prior interrupted private run.
