# Research record

This directory keeps the durable conclusions that shaped the private slice.
The detailed dated working notes remain in the project transfer archive while
the product name is unsettled; the conclusions and release gates needed to
understand or review this repository are recorded here and in the linked ADRs.

## Verified conclusions used by the implementation

- A username-first web product can enumerate owned public repositories through
  GitHub GraphQL with REST as a slower fallback. Completeness requires explicit
  pagination, total-count consistency, immutable repository/account IDs, and
  exact commit object IDs; API success alone is not proof of a complete ledger.
- Repository archives and scanner output are hostile data. Safe acquisition
  needs manual redirect validation, credential stripping, stream limits, a
  project-controlled archive parser, no target execution, fixed failures, and
  cleanup before any hosted result is accepted.
- A third-party scanner's `--redact` option is not a sufficient hosted-data
  boundary. This design therefore converts allowlisted rule IDs to numeric
  tokens in the hostile domain and reconstructs display metadata only in a
  source-blind trusted broker.
- Gitleaks release checksums establish the identity of downloaded artifacts;
  they do not establish reproducible or project-attested provenance. Public
  release retains a separate provenance gate.
- zizmor's attested release archive can audit this project's own workflow,
  action, Dependabot, and pre-commit definitions fully offline. CI forces
  `--no-config`, `--no-ignores`, all-input collection, strict parsing, and the
  versioned JSON-v1 format; this self-scan does not claim that the product's
  hosted workflow specialist is integrated.
- OSV-Scanner's release API digest and SLSA provenance identify the pinned
  binary used to check this project's own exact pnpm lockfile. CI disables
  dependency resolution and call analysis. This narrow self-scan may query the
  public OSV service with project-owned package names/versions; it is separate
  from the future target scanner, which remains gated on the attested offline
  database design.
- A static host can serve the interface but cannot provide the scanner worker.
  The default-zero-cost architecture therefore separates a portable Hono
  control plane/durable ledger from pull-based isolated workers. Provider free
  quotas are capacity inputs, never correctness assumptions; exhaustion must
  queue, retry, or report partial coverage.
- macOS process separation is not a public hostile-code sandbox. The accepted
  production worker boundary is Linux with a non-root identity, no scanner
  network, read-only trusted tools, tmpfs scratch, resource/process limits, and
  crash/reboot cleanup evidence.
- Small/free model accuracy requires orchestration rather than trust in one
  answer: two blind family-distinct scouts, deterministic byte/symbol/trace
  grounding, and an adversarial family-distinct judge. This remains a designed
  future lane; the current repository intentionally contains no model adapter.

## Primary references

- [GitHub GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- [GitHub repository archive REST endpoint](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [Gitleaks releases](https://github.com/gitleaks/gitleaks/releases)
- [Gitleaks configuration](https://github.com/gitleaks/gitleaks#configuration)
- [zizmor releases](https://github.com/zizmorcore/zizmor/releases)
- [zizmor usage and offline mode](https://docs.zizmor.sh/usage/)
- [OSV-Scanner releases](https://github.com/google/osv-scanner/releases)
- [OSV-Scanner source-scan usage](https://google.github.io/osv-scanner/usage/scan-source)
- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/)
- [OWASP path traversal guidance](https://owasp.org/www-community/attacks/Path_Traversal)
- [OWASP secrets management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [SLSA provenance concepts](https://slsa.dev/spec/v1.0/provenance)

Platform quotas, model availability, retention terms, and pricing are
time-sensitive and must be reverified from their primary sources immediately
before a public implementation or provider activation.

## Related repository records

- [Architecture](../architecture.md)
- [Threat model](../threat-model.md)
- [Decisions](../decisions.md)
- [Maintenance and verification](../maintenance.md)
- [Private-slice retrospective](../retrospective.md)
