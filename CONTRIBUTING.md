# Contributing

The service is live and public at
[repo-security-lab.rivinsand.workers.dev](https://repo-security-lab.rivinsand.workers.dev),
and this repository is where it is built. Review-quality patches are welcome.
This file said the project was not accepting public production use until
2026-08-24, which had been untrue for as long as the service had been open.

Requirements:

- Node 24 or newer and pnpm 10.33.0.
- Treat every target archive and scanner field as hostile data.
- Only a validated repository-relative path and line number may cross the
  hosted boundary, and only through the location channel, never the broker
  packet. Never add a snippet, match, package string, upstream error body, or
  secret-bearing value.
- Never execute target dependencies, scripts, tests, builds, hooks, or config.
- Public third-party scans and model source submission are on, and are what
  the service does. Do not widen what leaves the sandbox: the evidence channel
  carries numeric manifest tokens and count buckets, the location channel
  carries a validated repository-relative path and a line number, and nothing
  else crosses.
- Preserve fixed non-echoing failures and explicit partial/unsupported
  coverage; do not turn a missing specialist into success.

Before opening a change, run:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm lint
pnpm test:workers
pnpm test:coverage
pnpm build
pnpm build:control-plane
```

Changes to archive parsing, cleanup/publication ordering, scanner identity,
broker egress, anonymous disclosure, CI pins, or AI provider vocabulary require
new adversarial tests and a security-review note in `docs/decisions.md`.
