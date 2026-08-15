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
- **Dependencies:** lean by policy. Runtime dependency of the contracts
  package is Zod only; everything else is dev tooling. Dependency majors track
  the current stable release compatible with Node 24; version adjustments
  against the original implementation plan are recorded in
  `docs/decisions.md`.

## Verification commands

```sh
pnpm install          # resolves/checks the committed lockfile
pnpm typecheck        # strict TypeScript over all packages and tests
pnpm lint             # ESLint flat config, type-checked rules
pnpm test             # Vitest, includes the rename guard and contract suites
pnpm check            # all of the above
```
