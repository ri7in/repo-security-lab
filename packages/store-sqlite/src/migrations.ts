/**
 * Versioned local schema. Tables are STRICT as recommended for the future D1
 * adapter. SQL avoids triggers and stores progressive coverage as closed rows,
 * not JSON. Transaction control used by the local adapter is intentionally not
 * part of this migration because D1 supplies its own transaction semantics.
 */
export const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS scan_requests (
  request_id TEXT PRIMARY KEY,
  github_account_id INTEGER NOT NULL CHECK (github_account_id >= 0),
  username TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','discovering','scanning','complete','failed')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('GITHUB_RATE_LIMIT','GITHUB_NOT_FOUND','ARCHIVE_LIMIT','ARCHIVE_UNSAFE','ARCHIVE_INVALID','REPOSITORY_CHANGED','VULNERABILITY_DB_UNVERIFIED','VULNERABILITY_DB_STALE','VULNERABILITY_DB_MISMATCH','SCANNER_TIMEOUT','SCANNER_MEMORY_LIMIT','SCANNER_OUTPUT_LIMIT','SCANNER_INTERNAL','UNSUPPORTED_ECOSYSTEM','NORMALIZATION_REJECTED','FINDING_LIMIT','SOURCE_CLEANUP_FAILED','LEASE_RETRY_EXHAUSTED','D1_WRITE_RESERVE','CANCELLED','PRIVATE_SLICE_SCOPE')),
  discovery_complete INTEGER NOT NULL CHECK (discovery_complete IN (0,1)),
  ai_lane TEXT NOT NULL CHECK (ai_lane IN ('ai_not_run','ai_waiting','ai_partial')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS repositories (
  request_id TEXT NOT NULL REFERENCES scan_requests(request_id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL CHECK (repository_id >= 0),
  name TEXT NOT NULL,
  commit_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('discovered','waiting','leased','acquiring','guarding','scanning','normalizing','cleaning','uploading','waiting_to_publish','complete','empty','partial','failed','cancelled')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('GITHUB_RATE_LIMIT','GITHUB_NOT_FOUND','ARCHIVE_LIMIT','ARCHIVE_UNSAFE','ARCHIVE_INVALID','REPOSITORY_CHANGED','VULNERABILITY_DB_UNVERIFIED','VULNERABILITY_DB_STALE','VULNERABILITY_DB_MISMATCH','SCANNER_TIMEOUT','SCANNER_MEMORY_LIMIT','SCANNER_OUTPUT_LIMIT','SCANNER_INTERNAL','UNSUPPORTED_ECOSYSTEM','NORMALIZATION_REJECTED','FINDING_LIMIT','SOURCE_CLEANUP_FAILED','LEASE_RETRY_EXHAUSTED','D1_WRITE_RESERVE','CANCELLED','PRIVATE_SLICE_SCOPE')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at_ms INTEGER,
  published_lease_generation INTEGER CHECK (published_lease_generation IS NULL OR published_lease_generation > 0),
  discovered_at_ms INTEGER NOT NULL CHECK (discovered_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (request_id, repository_id),
  CHECK ((commit_sha IS NULL) OR (length(commit_sha) = 40)),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at_ms IS NULL) OR
    (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS repository_coverage (
  request_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  specialist TEXT NOT NULL CHECK (specialist IN ('snapshot','archive_guard','gitleaks','osv','zizmor','opengrep')),
  progress_state TEXT NOT NULL CHECK (progress_state IN ('waiting','complete','not_applicable','unsupported','partial','failed')),
  PRIMARY KEY (request_id, repository_id, specialist),
  FOREIGN KEY (request_id, repository_id)
    REFERENCES repositories(request_id, repository_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS repositories_claim_order
  ON repositories(state, attempt_count, repository_id, request_id);
CREATE INDEX IF NOT EXISTS repositories_lease_expiry
  ON repositories(lease_expires_at_ms)
  WHERE lease_expires_at_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS repositories_request_state
  ON repositories(request_id, state);
`;

export const MIGRATION_002 = `
CREATE TABLE scan_requests_v2 (
  request_id TEXT PRIMARY KEY,
  github_account_id INTEGER CHECK (github_account_id IS NULL OR github_account_id >= 0),
  username TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','discovering','scanning','complete','failed')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('GITHUB_RATE_LIMIT','GITHUB_NOT_FOUND','ARCHIVE_LIMIT','ARCHIVE_UNSAFE','ARCHIVE_INVALID','REPOSITORY_CHANGED','VULNERABILITY_DB_UNVERIFIED','VULNERABILITY_DB_STALE','VULNERABILITY_DB_MISMATCH','SCANNER_TIMEOUT','SCANNER_MEMORY_LIMIT','SCANNER_OUTPUT_LIMIT','SCANNER_INTERNAL','UNSUPPORTED_ECOSYSTEM','NORMALIZATION_REJECTED','FINDING_LIMIT','SOURCE_CLEANUP_FAILED','LEASE_RETRY_EXHAUSTED','D1_WRITE_RESERVE','CANCELLED','PRIVATE_SLICE_SCOPE')),
  discovery_complete INTEGER NOT NULL CHECK (discovery_complete IN (0,1)),
  ai_lane TEXT NOT NULL CHECK (ai_lane IN ('ai_not_run','ai_waiting','ai_partial')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO scan_requests_v2
SELECT * FROM scan_requests;

DROP TABLE scan_requests;
ALTER TABLE scan_requests_v2 RENAME TO scan_requests;

ALTER TABLE repositories
  ADD COLUMN is_fork INTEGER NOT NULL DEFAULT 0 CHECK (is_fork IN (0,1));
`;

export const MIGRATION_003 = `
CREATE TABLE findings (
  finding_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40),
  engine TEXT NOT NULL CHECK (engine IN ('gitleaks','osv','zizmor','opengrep')),
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info','unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low','unknown')),
  occurrence_bucket TEXT NOT NULL CHECK (occurrence_bucket IN ('one','two_to_five','six_to_twenty','twenty_one_plus')),
  remediation_key TEXT NOT NULL,
  owner_detail_ref TEXT NOT NULL,
  FOREIGN KEY (request_id, repository_id)
    REFERENCES repositories(request_id, repository_id) ON DELETE CASCADE,
  UNIQUE (request_id, repository_id, engine, rule_id)
) STRICT;

CREATE INDEX findings_request_order
  ON findings(request_id, finding_id);

CREATE UNIQUE INDEX scan_requests_one_active_account
  ON scan_requests(github_account_id)
  WHERE github_account_id IS NOT NULL
    AND state IN ('accepted','discovering','scanning');
`;

export const MIGRATION_004 = `
CREATE UNIQUE INDEX scan_requests_one_active_username
  ON scan_requests(lower(username))
  WHERE state IN ('accepted','discovering','scanning');
`;

export const SCHEMA_VERSION = 4;
