# repo-security-lab

> The name is a development placeholder; renaming is mechanical and lives in
> `packages/branding`.

Free security reports for every public repository a GitHub account owns. Enter
a username, and each repository is scanned for leaked credentials and insecure
GitHub Actions workflows; the three most recently updated also get a
line-by-line AI review. The report states, per repository, which checks ran
and which did not.

**Live at
[repo-security-lab.rivinsand.workers.dev](https://repo-security-lab.rivinsand.workers.dev).**
Anyone can scan any public GitHub account, with no sign-up.

The properties that make this safe to run against strangers' code:

- Scanned code is hostile data and is **never executed**.
- A scanned repository cannot write into its own report: only numeric tokens
  cross the sandbox boundary, and every word a reader sees comes from a fixed
  manifest on the trusted side.
- A model cannot add a finding, and can delete one only when the two most
  trusted judges that answered both reject it.
- The AI review sends public source to model providers, and the site says so
  plainly. `AI_REVIEW_ENABLED=false` stops it.

The full list, with the enforcement behind each item, is in
[docs/guarantees.md](docs/guarantees.md).

## Development

Requires Node >= 24 and pnpm.

```sh
pnpm install
pnpm check                 # typecheck + lint + Node and workerd tests
pnpm test:coverage         # enforced Node coverage floor
pnpm build:all             # scan-domain/worker + production Worker bundles
```

Deploy only with `deploy/redeploy.sh`. The checked-in Cloudflare config is
fail-closed on purpose, so a fresh clone cannot open a public service by
accident; the script passes the live flags and verifies the deployment. A bare
`wrangler deploy` takes the live service down to nobody.

## Documentation

- [docs/guarantees.md](docs/guarantees.md): what the service promises, and how
  each promise is enforced.
- [docs/architecture.md](docs/architecture.md): the end-to-end design.
- [docs/threat-model.md](docs/threat-model.md): adversaries, trust boundaries,
  and open gates.
- [docs/layout.md](docs/layout.md): what every package and app is for.
- [docs/maintenance.md](docs/maintenance.md): runbooks, the local runtime, and
  deployment.
- [docs/decisions.md](docs/decisions.md): the decision records.
- [docs/privacy.md](docs/privacy.md) and
  [docs/acceptable-use.md](docs/acceptable-use.md): the policies the site
  ships.
