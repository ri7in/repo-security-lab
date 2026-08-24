# Privacy

Last updated: 2026-08-23

This service scans public GitHub repositories and publishes a public
coverage and findings report. It does not require an account, set cookies, or run analytics.

## Data handled

- The submitted GitHub username, public repository names, public repository
  identifiers, and immutable commit hashes are stored with the report.
- Public repository archives are downloaded to private worker scratch storage,
  treated as hostile data, never executed, and deleted before findings are
  published. Repository source is not stored in the control-plane database.
- Reports contain fixed coverage states, manifest-derived finding metadata,
  and the file path and line number of each match. They cannot contain source
  code, snippets, raw matches, secret values, or scanner prose.
- During the private preview, optional report email is restricted to one
  operator-controlled address and encrypted with AES-GCM at rest. Its
  ciphertext is erased after successful delivery or the final failed attempt.
  A keyed recipient hash remains only until the report is deleted, to enforce
  the one-email-per-day abuse limit. Public scanning disables email until a
  recipient-consent flow exists.
- Cloudflare may process the requester IP at the edge for transport and rate
  limiting. The application does not store requester IP addresses. It does
  store the two letter country code Cloudflare resolves at the edge, once per
  scan request, in the `country` column of `scan_requests`, and the operator
  usage log reads it. It is deleted with the report.

GitHub receives normal API and archive requests. If optional email is enabled,
Google Apps Script and Gmail receive the destination address and public report
URL solely to send one transactional message.

Repository source IS sent to model providers. The reader takes whole source
files to OpenRouter, with every line the secret scanner matched blanked first.
An excerpt of up to 120 lines around each secret-scanner finding goes to
OpenRouter, Google and Groq, so models from different companies can vote on
whether it is a false alarm; a finding is removed only when the two most
capable models that answered both reject it. The excerpt has every matched
credential blanked; the only facts a model gets about the value are its
length and which common placeholder words it contains, from a fixed list.
Those providers may retain or train on what they receive.
`AI_REVIEW_ENABLED=false` stops both. The user-facing statement of this is
`apps/web/public/privacy.html`; `docs/architecture.md` has the mechanics.

## Retention and visibility

Reports are public to anyone with the report URL. Terminal reports and their
repository ledger, findings, quota records, and remaining notification metadata
are automatically deleted 30 days after their last update. Active work with no
update for 24 hours is failed, its leases are invalidated, and queued email
ciphertext is erased; the terminal report then follows the 30-day policy.

For a removal or privacy request, contact the operator through the public
GitHub profile at <https://github.com/ri7in> and include only the report ID. Do
not post secrets or vulnerable source details publicly.
