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

/**
 * Widen the closed failure vocabulary without weakening either table to free
 * text. SQLite cannot alter a CHECK constraint in place, so both tables are
 * rebuilt while the adapter has foreign keys disabled around its transaction.
 */
export const MIGRATION_005 = `
CREATE TABLE scan_requests_v5 (
  request_id TEXT PRIMARY KEY,
  github_account_id INTEGER CHECK (github_account_id IS NULL OR github_account_id >= 0),
  username TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','discovering','scanning','complete','failed')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('GITHUB_RATE_LIMIT','GITHUB_NOT_FOUND','GITHUB_NETWORK','GITHUB_AUTH','ARCHIVE_LIMIT','ARCHIVE_UNSAFE','ARCHIVE_INVALID','REPOSITORY_CHANGED','VULNERABILITY_DB_UNVERIFIED','VULNERABILITY_DB_STALE','VULNERABILITY_DB_MISMATCH','SCANNER_TIMEOUT','SCANNER_MEMORY_LIMIT','SCANNER_OUTPUT_LIMIT','SCANNER_INTERNAL','UNSUPPORTED_ECOSYSTEM','NORMALIZATION_REJECTED','FINDING_LIMIT','SOURCE_CLEANUP_FAILED','LEASE_RETRY_EXHAUSTED','D1_WRITE_RESERVE','CANCELLED','PRIVATE_SLICE_SCOPE')),
  discovery_complete INTEGER NOT NULL CHECK (discovery_complete IN (0,1)),
  ai_lane TEXT NOT NULL CHECK (ai_lane IN ('ai_not_run','ai_waiting','ai_partial')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO scan_requests_v5
SELECT * FROM scan_requests;

DROP TABLE scan_requests;
ALTER TABLE scan_requests_v5 RENAME TO scan_requests;

CREATE TABLE repositories_v5 (
  request_id TEXT NOT NULL REFERENCES scan_requests(request_id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL CHECK (repository_id >= 0),
  name TEXT NOT NULL,
  commit_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('discovered','waiting','leased','acquiring','guarding','scanning','normalizing','cleaning','uploading','waiting_to_publish','complete','empty','partial','failed','cancelled')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('GITHUB_RATE_LIMIT','GITHUB_NOT_FOUND','GITHUB_NETWORK','GITHUB_AUTH','ARCHIVE_LIMIT','ARCHIVE_UNSAFE','ARCHIVE_INVALID','REPOSITORY_CHANGED','VULNERABILITY_DB_UNVERIFIED','VULNERABILITY_DB_STALE','VULNERABILITY_DB_MISMATCH','SCANNER_TIMEOUT','SCANNER_MEMORY_LIMIT','SCANNER_OUTPUT_LIMIT','SCANNER_INTERNAL','UNSUPPORTED_ECOSYSTEM','NORMALIZATION_REJECTED','FINDING_LIMIT','SOURCE_CLEANUP_FAILED','LEASE_RETRY_EXHAUSTED','D1_WRITE_RESERVE','CANCELLED','PRIVATE_SLICE_SCOPE')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at_ms INTEGER,
  published_lease_generation INTEGER CHECK (published_lease_generation IS NULL OR published_lease_generation > 0),
  discovered_at_ms INTEGER NOT NULL CHECK (discovered_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  is_fork INTEGER NOT NULL DEFAULT 0 CHECK (is_fork IN (0,1)),
  PRIMARY KEY (request_id, repository_id),
  CHECK ((commit_sha IS NULL) OR (length(commit_sha) = 40)),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at_ms IS NULL) OR
    (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

INSERT INTO repositories_v5
SELECT * FROM repositories;

DROP TABLE repositories;
ALTER TABLE repositories_v5 RENAME TO repositories;

CREATE UNIQUE INDEX scan_requests_one_active_account
  ON scan_requests(github_account_id)
  WHERE github_account_id IS NOT NULL
    AND state IN ('accepted','discovering','scanning');
CREATE UNIQUE INDEX scan_requests_one_active_username
  ON scan_requests(lower(username))
  WHERE state IN ('accepted','discovering','scanning');
CREATE INDEX repositories_claim_order
  ON repositories(state, attempt_count, repository_id, request_id);
CREATE INDEX repositories_lease_expiry
  ON repositories(lease_expires_at_ms)
  WHERE lease_expires_at_ms IS NOT NULL;
CREATE INDEX repositories_request_state
  ON repositories(request_id, state);
`;

/**
 * Persist canonical per-engine failure attribution beside repository state.
 * The map stays source-blind: keys and values are closed contract enums.
 */
export const MIGRATION_006 = `
ALTER TABLE repositories
  ADD COLUMN specialist_reasons TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(specialist_reasons) AND json_type(specialist_reasons) = 'object');
`;

const waitingCoverageJson = JSON.stringify(
  Object.fromEntries(SPECIALISTS.map((specialist) => [specialist, "waiting"])),
);

const migratedCoverageObject = `json_object(${SPECIALISTS.flatMap(
  (specialist) => [
    `'${specialist}'`,
    `COALESCE((SELECT progress_state FROM repository_coverage c WHERE c.request_id = repositories.request_id AND c.repository_id = repositories.repository_id AND c.specialist = '${specialist}'), 'waiting')`,
  ],
).join(", ")})`;

const repositoryTotalsObject = `json_object(${REPOSITORY_STATES.flatMap(
  (state) => [
    `'${state}'`,
    `(SELECT COUNT(*) FROM repositories r WHERE r.request_id = scan_requests.request_id AND r.state = '${state}')`,
  ],
).join(", ")})`;

const coverageTotalsObject = `json_object(${SPECIALISTS.flatMap(
  (specialist) => [
    `'${specialist}'`,
    `json_object(${SPECIALIST_PROGRESS_STATES.flatMap((state) => [
      `'${state}'`,
      `(SELECT COUNT(*) FROM repositories r WHERE r.request_id = scan_requests.request_id AND json_extract(r.coverage_json, '$.${specialist}') = '${state}')`,
    ]).join(", ")})`,
  ],
).join(", ")})`;

const repositoryTotalsAfterUpdate = `json_set(repository_totals, ${REPOSITORY_STATES.flatMap(
  (state) => [
    `'$.${state}'`,
    `json_extract(repository_totals, '$.${state}') + CASE WHEN NEW.state = '${state}' THEN 1 ELSE 0 END - CASE WHEN OLD.state = '${state}' THEN 1 ELSE 0 END`,
  ],
).join(", ")})`;

const coverageTotalsAfterUpdate = `json_set(coverage_totals, ${SPECIALISTS.flatMap(
  (specialist) =>
    SPECIALIST_PROGRESS_STATES.flatMap((state) => [
      `'$.${specialist}.${state}'`,
      `json_extract(coverage_totals, '$.${specialist}.${state}') + CASE WHEN json_extract(NEW.coverage_json, '$.${specialist}') = '${state}' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.${specialist}') = '${state}' THEN 1 ELSE 0 END`,
    ]),
).join(", ")})`;

/**
 * Collapse coverage into each repository row and add O(1) request totals.
 * The update trigger keeps both closed counter maps in the same transaction
 * as every repository state/coverage mutation.
 */
export const MIGRATION_007 = `
ALTER TABLE repositories
  ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '${waitingCoverageJson}'
  CHECK (json_valid(coverage_json) AND json_type(coverage_json) = 'object');

UPDATE repositories SET coverage_json = ${migratedCoverageObject};

CREATE TABLE request_totals (
  request_id TEXT PRIMARY KEY REFERENCES scan_requests(request_id) ON DELETE CASCADE,
  repository_totals TEXT NOT NULL
    CHECK (json_valid(repository_totals) AND json_type(repository_totals) = 'object'),
  coverage_totals TEXT NOT NULL
    CHECK (json_valid(coverage_totals) AND json_type(coverage_totals) = 'object')
) STRICT;

INSERT INTO request_totals(request_id, repository_totals, coverage_totals)
SELECT request_id, ${repositoryTotalsObject}, ${coverageTotalsObject}
FROM scan_requests;

DROP TABLE repository_coverage;

CREATE TRIGGER request_totals_after_repository_update
AFTER UPDATE OF state, coverage_json ON repositories
WHEN OLD.state <> NEW.state OR OLD.coverage_json <> NEW.coverage_json
BEGIN
  UPDATE request_totals
  SET repository_totals = ${repositoryTotalsAfterUpdate},
      coverage_totals = ${coverageTotalsAfterUpdate}
  WHERE request_id = NEW.request_id;
END;
`;

export const MIGRATION_008 = `
ALTER TABLE findings ADD COLUMN locations_json TEXT
  CHECK (locations_json IS NULL OR json_valid(locations_json));
`;

/**
 * Admits `ai` as a fifth engine.
 *
 * SQLite cannot alter a CHECK constraint, so both tables are rebuilt. Rebuild
 * order matters: foreign keys are suspended for the transaction, the data is
 * copied, and the indexes are recreated afterwards, because dropping a table
 * takes its indexes with it.
 */
/**
 * Admits `ai` as a fifth engine.
 *
 * Only `findings` is rebuilt. The old `repository_coverage` table carried the
 * other engine CHECK and was dropped by migration 5, which replaced it with a
 * JSON column validated by shape rather than by an enumerated list, so it
 * accepts a new engine without being touched.
 *
 * SQLite cannot alter a CHECK, hence the copy. Foreign keys are suspended for
 * the rebuild and the index is recreated afterwards, because dropping a table
 * takes its indexes with it.
 */
export const MIGRATION_009 = `
PRAGMA foreign_keys = OFF;

CREATE TABLE findings_next (
  finding_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40),
  engine TEXT NOT NULL CHECK (engine IN ('gitleaks','osv','zizmor','opengrep','ai')),
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info','unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low','unknown')),
  occurrence_bucket TEXT NOT NULL CHECK (occurrence_bucket IN ('one','two_to_five','six_to_twenty','twenty_one_plus')),
  remediation_key TEXT NOT NULL,
  owner_detail_ref TEXT NOT NULL,
  locations_json TEXT CHECK (locations_json IS NULL OR json_valid(locations_json)),
  FOREIGN KEY (request_id, repository_id)
    REFERENCES repositories(request_id, repository_id) ON DELETE CASCADE,
  UNIQUE (request_id, repository_id, engine, rule_id)
) STRICT;

INSERT INTO findings_next SELECT
  finding_id, request_id, repository_id, commit_sha, engine, rule_id,
  category, severity, confidence, occurrence_bucket, remediation_key,
  owner_detail_ref, locations_json
FROM findings;

DROP TABLE findings;
ALTER TABLE findings_next RENAME TO findings;

CREATE INDEX findings_request_order
  ON findings(request_id, finding_id);

PRAGMA foreign_keys = ON;
`;

export const SCHEMA_VERSION = 9;
import {
  REPOSITORY_STATES,
  SPECIALISTS,
  SPECIALIST_PROGRESS_STATES,
} from "@app/contracts";
