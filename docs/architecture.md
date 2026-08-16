# Architecture

**Status:** private end-to-end vertical slice. Discovery, durable scheduling,
immutable archive acquisition, guarded extraction, real Gitleaks scanning,
engine-isolated source-blind publication, the local API/worker runtime,
responsive web UI, and the CI canary proof are implemented. Public deployment
and third-party scans remain gated on Linux isolation and an approved
deployment identity.

## Product flow

1. The browser submits a GitHub username and receives a durable request ID.
   A local-runtime restart replays every accepted/discovering row in bounded
   pages before serving,
   so a crash between the 202 response and ledger installation does not strand
   the username or require an in-memory callback to survive.
2. Authenticated GraphQL discovery enumerates every owned public repository,
   including forks and empty repositories, and binds non-empty work to the
   default branch's immutable commit SHA. A slower REST path is available.
3. SQLite atomically installs the complete repository ledger. Workers claim
   rows with generation-bearing leases and stable ordering.
4. A worker requests the exact commit archive, manually validates the GitHub
   codeload redirect, strips authorization before codeload, streams through a
   compressed-size limit, and writes into a private tuple-keyed scratch root.
5. The archive guard validates tar structure, paths, entry types, checksums,
   Unicode, PAX metadata, sizes, counts, and expansion ratio while extracting
   regular files only. Repository code is never executed.
6. The exact hash-verified Gitleaks 8.30.1 binary runs with project-owned
   configuration, target configuration disabled, bounded process output and
   time, and full secret redaction. Each POSIX command owns a process group
   that is terminated on leader exit, timeout, output overflow, or process
   error. This descendant cleanup is defense in depth, not the Linux cgroup
   isolation required for public release. A separate bounded name/type-only
   walk reports an unintegrated specialist `not_applicable` only after proving
   whole-tree absence; relevant input or an incomplete walk is `unsupported`.
7. Each hostile scanner/normalizer lane is independent. It discards paths,
   matches, snippets, and all other source strings, then emits only
   manifest-issued numeric rule tokens and four count-bucket codes. One lane's
   scanner, normalizer, or broker failure cannot discard another lane's
   already-valid evidence.
8. The entire tuple-keyed scratch root is removed and absence is verified.
   Only then can each trusted engine-bound broker map numeric tokens to closed
   metadata and publish findings with durable lease identity. Mixed outcomes
   publish `partial` plus a closed per-engine failure map; the map cannot carry
   target text.
9. The anonymous API exposes exhaustive status and coverage, never findings.
   A local operator endpoint is available only when explicitly enabled and
   bound to loopback. Operator mode automatically validates the literal `Host`
   header to reject DNS-rebinding access; the composed runtime also enables
   that guard for every route.

## Trust boundaries

### Hostile source domain

Archive bytes, extracted files, and raw scanner output are hostile. They may
contain traversal attempts, prompt injection, terminal controls, fake configs,
or secret material. No value from this domain becomes a hosted string.

### Source-blind broker

The broker is constructed for one engine and one pinned manifest. Engine
identity is out-of-band; the hostile packet has no engine field. Packets are
strict JSON, at most 64 KiB, and contain at most 256 unique numeric groups.
Unknown tokens or any extra field reject the entire packet with one fixed
error. Request, repository, commit, and owner-detail identity come from the
trusted lease context.

### Durable state

The portable Store contract is asynchronous. The exercised adapter uses
STRICT SQLite tables, normalized coverage, schema migrations, atomic
`UPDATE ... RETURNING` claims, monotonic lease generations, exact idempotent
publication, and generation-specific stale cleanup. A request is complete only
when every ledger row is terminal.

Repository publication persists canonical per-engine failure attribution next
to the aggregate terminal reason. Complete rows have no failed lanes or reason
map; partial rows preserve every successful lane and attribute every failed
lane; failed rows have no successful lane. Exact publication retries compare
coverage, the canonical reason map, and findings.

### Browser and anonymous API

The browser is a viewer and controller only. Strict anonymous response schemas
cannot express finding data, paths, snippets, secrets, or free-form upstream
errors. Responses use `no-store`, `nosniff`, and `no-referrer`; unexpected
exceptions collapse to one fixed 500 response.

## AI boundary

The current AI lane is deliberately inert. It has strict candidate contracts,
two family-distinct deterministic fixture scouts, an exact file/line/quote/
symbol/trace grounding validator, and a fixture judge. The default is
`ai_not_run`; the only provider tag is `fixture`, and registration of any real
adapter throws. No repository byte can reach a model from this codebase.

A real provider lane requires separate owner consent, provider/data-use proof,
secret-sanitizer proof, family routing, benchmark evidence, quota accounting,
and a second authorization. AI can add candidates but can never suppress a
deterministic finding.

## Private runtime and deployment boundary

`apps/api/src/server.ts` composes the real local stack. It requires immutable
GitHub account IDs and the exact scanner path/hash, removes startup orphans,
reaps expired generations, and polls work without concurrent ticks. It refuses
all public bind addresses and non-matching Host headers. The private worker
also terminalizes forks as
`PRIVATE_SLICE_SCOPE`: owning a fork does not make its upstream source
operator-authored. The web development server proxies `/api` to this loopback
runtime.

The production web bundle is static and deployable, but a public frontend alone
is not the scanner backend. No deployment has been made because the available
Vercel identity is not authenticated and therefore cannot yet be proven to be
the owner's personal account rather than the excluded organization account.

## Verification layers

- Unit and integration suites cover the full repository state-pair matrix,
  migrations, two-connection claim races, GitHub pagination/errors, archive
  hostility, scanner pinning, broker smuggling, cleanup, API safety, UI build,
  and inert AI grounding.
- The real-binary end-to-end test drives API → store → guarded archive → exact
  Gitleaks → cleanup → broker → API, then scans SQLite, every captured response,
  fixed process logs, and scratch storage for a planted `RVN_` marker, a
  synthetic secret, and every eight-character window of both.
- CI pins every third-party action to a full commit SHA, downloads the exact
  Gitleaks Linux archive and verifies both archive and binary hashes, runs the
  full gate and real-binary canary proof, builds the web app, and self-scans the
  repository tree plus full Git history.

## Known release gates

- Enforced Linux privilege separation, no-network sandboxing, cgroups, tmpfs,
  crash/reboot cleanup, and swap policy.
- Deployed control-plane semantics and abuse/rate-limit controls.
- Owner authentication for finding detail, public disclosure UX, and privacy
  review.
- Project-attested scanner build provenance; a release hash pin is identity,
  not provenance.
- OSV, workflow, and source-rule specialists remain unintegrated; relevant
  input or input whose presence was not ruled out stays explicit
  `unsupported`.
- Public accessibility, load, cross-platform, and release-security audits.
