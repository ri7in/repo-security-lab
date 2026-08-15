# Third-party notices

The private slice invokes, but does not commit, the standalone Gitleaks scanner
version 8.30.1. Gitleaks is distributed under the MIT License. Its executable,
release archive, default rule configuration, and project-owned integration are
kept distinct from the separately licensed commercial Gitleaks Action.

The scanner adapter extends the verified built-in Gitleaks rules through a
small project-owned configuration and records the exact upstream source commit
and configuration hash in `packages/scanners/src/manifest.ts`. CI downloads the
official standalone release asset and verifies both archive and binary hashes.

JavaScript dependency names, versions, resolved integrity values, and licenses
are recorded by `pnpm-lock.yaml` and their upstream packages. No model weights,
third-party security rule pack, repository archive, or vulnerability database
is vendored in this slice.
