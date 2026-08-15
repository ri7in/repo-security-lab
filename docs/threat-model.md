# Threat model

**Scope:** private vertical slice. This document describes the implemented
local path and the gates that still prevent public third-party scanning. It is
not a claim that macOS process boundaries provide production sandboxing.

## Assets and security objectives

- Never execute a target repository's code, dependencies, scripts, hooks,
  tests, builds, containers, or configuration-driven commands.
- Keep repository source, paths, snippets, scanner matches, and detected secret
  values out of hosted persistence, API responses, and logs.
- Preserve every discovered repository in an exhaustive coverage ledger; a
  limit or refusal must become an explicit outcome, never an omission.
- Keep deterministic findings immutable. AI may add separately grounded
  candidates in a future lane but may not suppress scanner evidence.
- Bind acquisition and publication to GitHub's immutable account/repository
  identities and an exact commit object ID.

## Adversaries and untrusted inputs

The visitor controls the submitted username and request timing. GitHub and the
network may return malformed, oversized, inconsistent, redirected, truncated,
or rate-limited responses. A public repository owner controls every archive
byte, filename, tar header, PAX record, file body, scanner configuration file,
and string the scanner may emit. Scanner output is treated as compromised even
when the executable itself matches the pinned release hash.

Local machine administrators and a compromised trusted scanner binary are
outside the private slice's containment guarantee. Public release therefore
requires the separate Linux privilege/no-network/cgroup/tmpfs boundary and
project-attested scanner provenance described below.

## Trust boundaries

### Control plane

The API validates a closed GitHub-login grammar, creates the request durably
before discovery, and admits only configured logins. Discovery then binds the
request to GitHub's immutable account ID and refuses IDs outside the private
allowlist. Complete pagination, stable totals, duplicate IDs, changing cursors,
and inconsistent account metadata fail closed.

### Acquisition and archive domain

Only exact commit archives are requested. The client manually accepts one
strict HTTPS codeload redirect and removes authorization before following it.
Response headers and streams are bounded and cancelled on rejection.

Archive bytes enter a tuple-keyed private scratch directory. The project-owned
parser accepts only regular files and directories and checks checksums,
padding, truncation, compressed/inflated/extracted/file sizes, expansion ratio,
entry count, depth, PAX metadata, Unicode normalization, case collisions,
traversal, links, devices, sparse entries, and ambiguous platform paths. Any
rejection removes only the destination created by that extraction attempt.

### Scanner and source-blind egress

Gitleaks runs without a shell, with a minimal environment, explicit trusted
configuration, target allowlisting disabled, full redaction, and time/output/
finding bounds. The adapter accepts only allowlisted rule IDs and verifies the
secret field is exactly redacted. Contextual match text is checked for the
redaction marker and discarded inside the hostile domain.

The normalizer emits strict JSON containing numeric manifest tokens and four
count-bucket codes only. The trusted broker is constructed for one engine and
manifest, rejects unknown/duplicate/extra content, derives all display strings
from that manifest, and injects request/repository/commit identity from the
lease. Archive-derived strings have no representable field across this boundary.

### Cleanup, leases, and persistence

Each claim increments a durable generation. Worker transitions, heartbeats,
cleanup recovery, and publication compare the exact request/repository/worker/
generation tuple. Source-bearing work cannot be voluntarily released. An
expired generation remains parked until its exact scratch path is removed and
an expiry/generation compare-and-swap requeues or terminalizes it. Normal
publication removes and verifies the entire tuple root before broker acceptance.

SQLite persists only control-plane repository names, closed coverage/failure
states, and broker-derived finding metadata. Raw source, paths, snippets,
matches, scanner stderr, and secret values are absent from its schema.

### Report and AI lanes

Anonymous DTOs expose exhaustive status and coverage but cannot express a
finding. The source-blind finding route exists only in explicit operator mode,
which requires a literal loopback bind and automatically enforces a matching
Host header. The composed runtime applies the same Host guard to every route.
Public finding detail remains gated on owner authentication.

The AI package is an unnetworked fixture harness. Its only provider tag is
`fixture`, its production default is disabled, and real adapter registration
throws. No model client or repository-to-provider route exists in this slice.

## Abuse and privacy limits

The private runtime is intentionally single-operator and sequentially paced.
It does not yet claim public multi-tenant abuse resistance, deployed queue
fairness, or owner authorization. Forks are represented but refused before
download because owned forks can contain third-party source. Logs carry fixed
event/result codes only.

## Public-release gates

- Run acquisition, parsing, scanning, and cleanup under a non-root Linux
  identity with no network, read-only trusted tools, tmpfs, cgroup/rlimit
  ceilings, process-count limits, swap policy, and crash/reboot cleanup proofs.
- Prove the deployed queue/store's lease, idempotency, rate-limit, and burst
  behavior; local SQLite evidence is not deployed D1 evidence.
- Add owner authentication and explicit source-processing disclosure before
  exposing finding detail or enabling any future AI source lane.
- Add project-attested/reproducible scanner provenance. A release archive hash
  proves identity, not that the upstream build is trustworthy.
- Integrate and test dependency, workflow, and source-rule specialists; until
  then their coverage remains explicitly `unsupported`.
