# Third-party notices

The service invokes, but does not commit, the standalone Gitleaks scanner
version 8.30.1. Gitleaks is distributed under the MIT License. Its executable,
release archive, default rule configuration, and project-owned integration are
kept distinct from the separately licensed commercial Gitleaks Action.

The scanner adapter extends the verified built-in Gitleaks rules through a
small project-owned configuration and records the exact upstream source commit
and configuration hash in `packages/scanners/src/manifest.ts`. CI downloads the
official standalone release asset and verifies both archive and binary hashes.

The isolated workflow lane invokes, but does not commit, Zizmor 1.29.0 under
its MIT License. The adapter pins the upstream source commit and Linux
x86-64/ARM64 release identities, and carries only a project-reviewed numeric
rule/variant manifest; no Zizmor descriptions, URLs, locations, or fixes are
vendored into public output.

The OCI host bootstrap installs the Ubuntu bubblewrap system package and an
official Node.js ARM64 release. Those tools remain separate host/runtime
components governed by their upstream distribution notices; they are not
redistributed in this repository.

JavaScript dependency names, versions, resolved integrity values, and licenses
are recorded by `pnpm-lock.yaml` and their upstream packages. No model weights,
third-party security rule pack, repository archive, or vulnerability database
is vendored in this slice.
