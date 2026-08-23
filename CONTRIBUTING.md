# Contributing

The project is not accepting public production use yet, but review-quality
patches are welcome in the private development repository.

Requirements:

- Node 24 or newer and pnpm 10.33.0.
- Treat every target archive and scanner field as hostile data.
- Only a validated repository-relative path and line number may cross the
  hosted boundary, and only through the location channel, never the broker
  packet. Never add a snippet, match, package string, upstream error body, or
  secret-bearing value.
- Never execute target dependencies, scripts, tests, builds, hooks, or config.
- Keep public third-party scans and model source submission disabled.
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
