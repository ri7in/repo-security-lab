# Architecture

**Status:** live and open. Anyone can scan any public GitHub account, with no
sign-up and no card. The Cloudflare Workers/D1 control plane, the same-origin
static site, the public report, the authenticated external pull worker running
under enforced Bubblewrap isolation, the credential-free Linux scan-domain
bundle, the AI reading pass, the optional encrypted email queue, and 30-day
report retention are all implemented and exercised against real accounts.

Reports show file paths and line numbers. They do not show source code, secret
values, or raw scanner matches. That was a deliberate reversal of the original
source-blind design and the reasoning is in `locations-decision.md`: a report
that says a credential exists somewhere in an account is not actionable, and
everything it now prints is already readable by anyone who clones the public
repository.

## Product flow

1. The browser submits a GitHub username and receives a durable request ID.
   A local-runtime restart replays every accepted/discovering row in bounded
   pages before serving,
   so a crash between the 202 response and ledger installation does not strand
   the username or require an in-memory callback to survive.
2. Authenticated GraphQL discovery enumerates every owned public repository,
   including forks and empty repositories, and binds non-empty work to the
   default branch's immutable commit SHA. A slower REST path is available.
3. SQLite (local) or D1 (hosted) atomically installs the complete repository
   ledger. D1 materializes request totals, stores findings in bounded JSON
   chunks, and reserves conservative modeled writes before admitting work.
   Workers claim rows with generation-bearing leases and stable ordering.
4. A worker requests the exact commit archive, manually validates the GitHub
   codeload redirect, strips authorization before codeload, streams through a
   compressed-size limit, and writes into a private tuple-keyed scratch root.
5. The archive guard validates tar structure, paths, entry types, checksums,
   Unicode, PAX metadata, sizes, counts, and expansion ratio while extracting
   regular files only. Repository code is never executed.
6. In public-worker mode, archive extraction and scanners run inside a
   bubblewrap namespace with no network, no ambient credentials, read-only
   trusted binaries, fixed mounts, and a startup escape probe. The exact
   hash-verified Gitleaks 8.30.1 binary runs with project-owned
   configuration, target configuration disabled, bounded process output and
   time, and full secret redaction. Zizmor 1.29.0 scans only worker-staged
   workflow bytes with offline/config/ignore overrides forced off and closed
   exit semantics. Each POSIX command owns a process group
   that is terminated on leader exit, timeout, output overflow, or process
   error. This descendant cleanup is defense in depth, not the Linux cgroup
   isolation required for public release. A separate bounded name/type-only
   walk reports an unintegrated specialist `not_applicable` only after proving
   whole-tree absence; relevant input or an incomplete walk is `unsupported`.
7. Each hostile scanner/normalizer lane is independent. The evidence channel
   still carries only manifest-issued numeric rule tokens and four count-bucket
   codes, so no scanner string reaches a report through it. Locations travel on
   a separate, narrow channel: a validated relative path and a line number,
   nothing else, capped per finding, with traversal and absolute paths refused
   at the source. Matches, snippets and secret values are never on either
   channel. One lane's scanner, normalizer, or broker failure cannot discard
   another lane's already-valid evidence.
8. The entire tuple-keyed scratch root is removed and absence is verified.
   Only then can each trusted engine-bound broker map numeric tokens to closed
   metadata and publish findings with durable lease identity. Mixed outcomes
   publish `partial` plus a closed per-engine failure map; the map cannot carry
   target text.
9. The anonymous API exposes exhaustive status, coverage, and a strict public
   subset of findings: the rule, the severity, the count bucket, the
   remediation key, and where each one is. That subset omits internal
   finding/request IDs and owner-detail references, and has no field for a
   snippet, a match, or a secret value. The full broker record remains
   available only through an explicitly enabled loopback operator endpoint with
   literal `Host` validation against DNS rebinding.

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
can express closed, broker-derived public finding metadata but cannot express
paths, snippets, matches, secrets, internal detail references, or free-form
upstream errors. Responses use `no-store`, `nosniff`, and `no-referrer`;
unexpected exceptions collapse to one fixed 500 response.

## The AI pass, and which model does what

The pass runs in the worker, not the sandbox, for one reason: the sandbox has
no network and the whole point of this pass is a model call. The worker holds
the extracted snapshot on disk until cleanup, so files are read there directly
rather than pushed back out through a result channel built for numbers.

| Role | Model | Provider | What it sees | What it can do |
| --- | --- | --- | --- | --- |
| Reader (pass 1) | `nvidia/nemotron-3-ultra-550b-a55b:free`, then a chain of free models from other labs (MiniMax, Zhipu, Google) for congestion diversity | OpenRouter | Whole repository, up to 400 files, secret lines blanked | Point at a file and line and name one of ten CWEs |
| Judge (pass 2) | `openai/gpt-oss-120b` | Groq | One flag, its excerpt, its file and line | Vote real, not real, or unsure |
| Judge (pass 2) | `gemini-flash-lite-latest` | Google | The same, independently | The same |

The judges also sit on a separate path, the council, where they review the
*scanner's* findings. That panel is trust-ordered: Gemini, then gpt-oss, then
Qwen. Each finding is decided by the
two most trusted judges that answered for it, unanimously; a junior judge can
neither veto them nor convict without them, and with the preview model down
the stable pair decides exactly as it always did. Rejection is per finding:
the rejected one is subtracted from its rule's exact count before the report's
buckets form, so a false alarm dies alone while the real finding beside it
survives. Every other outcome keeps the finding: fewer than two judges, two
judges of one family, an exhausted quota, a provider timing out, or any thrown
error at all. Deleting a real finding is far worse than showing a false one.

The reader judging scanner findings is not the reader judging itself: the
council runs on other providers entirely, and reviews Gitleaks output the
reader had no hand in producing.
On the funnel that judges the reader's own flags, the panel still excludes
the reader's family entirely.

Four rules hold the pass together, and each is enforced in code rather than
described here:

1. **A model cannot write into a report.** The reader's output is a file token,
   a line number, an excerpt and a CWE from a closed vocabulary of ten. Every
   word a reader eventually sees, including the rule name, the severity, the
   confidence and the remediation, is looked up from that CWE in a fixed
   manifest. A model that invents a class is dropped, not guessed at.

   The honest limit of this: the CWE is still the model's own choice, and the
   severity is that class's fixed rating, so a reader that calls an XSS a
   command injection moves the severity with it. The judges are asked whether
   the finding is real, never whether the class fits.
2. **A deterministic grounding gate sits between the passes**, and no model
   participates in it. A flag whose quote does not appear at the line it names
   never reaches a judge.
3. **The reader does not choose what gets judged.** The judge queue is ordered
   by position in the file before the cap bites, not by the reader's own
   confidence field. Ordering on a model-supplied field handed the reader
   control of which findings survived.
4. **Judges never see the reader's argument.** Its rationale is not in their
   prompt. Passing it anchors every judge to one model's case and hands a
   misbehaving reader a free-text channel into the prompt of the thing checking
   it.

Publication needs a strict majority of the judges that answered to say
"real", with at least one answer; a panel shorter than configured marks the
lane partial, so availability degrades confidence rather than silencing the
reader (operator decision, 2026-08-24). "Unsure"
counts against, because an abstention is not a vote in favour.

### What leaves the machine

Public source code from public repositories, with every line the secret scanner
matched blanked first. The pass looking for injection bugs has no use for a
credential and must not be handed one in passing. Providers may keep or train
on what they receive, which is what pays for the free tier this runs on, and
the footer says so whenever the pass is switched on.

The reader chain exists because the best free reader available is an unbranded
preview that can be withdrawn without notice. A chain makes that a non-event:
the fallback is only called after a failure, and the switch is logged rather
than swallowed, because a chain quietly running on its last link looks
identical to one running on its first.

`AI_REVIEW_ENABLED=false` turns the whole pass off in one variable. With it
off, every repository reports `unsupported` for the AI engine, which is honest:
the check exists and did not happen here.

### The daily budget

`packages/quota` holds one entry per model with a source URL and the date a
human read it. The council is only as available as its scarcest member, so the
meter on the landing page shows that member's remaining share of its own day,
never an average. A model whose limits the provider no longer publishes is not
registered, and a guard test refuses any model the worker names that is neither
budgeted nor excluded on the record.

## Private runtime and deployment boundary

`apps/api/src/server.ts` composes the real local stack. It requires immutable
GitHub account IDs and the exact scanner path/hash, removes startup orphans,
reaps expired generations, and polls work without concurrent ticks. It refuses
all public bind addresses and non-matching Host headers. The private worker
also terminalizes forks as
`PRIVATE_SLICE_SCOPE`: owning a fork does not make its upstream source
operator-authored. The web development server proxies `/api` to this loopback
runtime.

`apps/control-plane` serves the production web bundle and API from one
Cloudflare Worker. It uses D1, public write/read admission limits, a separate
worker-edge limit, cron discovery recovery, 24-hour abandoned-work expiry,
30-day terminal-report deletion, security headers, a switched-off
operator-only encrypted email queue, and a default-off public scanning switch.
Completed reports require no identity or
session. Legacy `/auth/` and `/api/owner/` routes return fixed 404 responses.
`apps/scan-worker` uses a narrowed HTTPS store adapter and rotating HMAC
identity. Its host process owns acquisition/control-plane egress; `apps/scan-domain`
receives only a fixed archive/source mount and emits strict numeric packets.
The server supplies all mutation timestamps, and every lease mutation remains
generation-bound and idempotent. `deploy/oci` pins ARM64 Node/Gitleaks/Zizmor,
installs a hardened non-root systemd service, and keeps public mode off until
the startup probe and synthetic job pass.

The current deployment URL is published in `README.md` and is backed by the
APAC D1 database recorded in `wrangler.jsonc`. Static assets run through the
Worker before the Assets binding so the same CSP, HSTS, frame, referrer, and
cross-origin policies cover the homepage and API. The
initial production failure was traced to native Worker `fetch` being invoked
with the wrong receiver; the fixed unbound call has a regression test and the
deployed path is green.

Vercel remains an isolated-compute candidate because Sandbox provides
Firecracker microVMs and network policy. It is not wired into the release: exact $0 allowance, snapshot,
deny-all scan phase, source-blind output, and lifecycle proof remain required.

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
- Workerd tests apply the real D1 migration and prove atomic discovery,
  materialized totals, write-reserve refusal, lease ABA protection, chunked
  publication, signed-worker rotation/revocation, fixed legacy-login refusal,
  and default-off public admission.

## Known release gates

- Provision and verify the prepared OCI Always Free worker; CI proves the same
  no-network scan-domain boundary, but the live host remains an owner action.
- Project-attested scanner build provenance; a release hash pin is identity,
  not provenance.
- OSV and source-rule specialists remain unintegrated. Zizmor is integrated but
  stays `unsupported` unless its pinned lane is enabled inside the proven Linux
  domain.
- Public accessibility, load, cross-platform, and release-security audits.
