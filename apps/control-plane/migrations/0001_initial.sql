CREATE TABLE scan_requests (
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

CREATE TABLE request_totals (
  request_id TEXT PRIMARY KEY REFERENCES scan_requests(request_id) ON DELETE CASCADE,
  repository_totals TEXT NOT NULL DEFAULT '{"discovered":0,"waiting":0,"leased":0,"acquiring":0,"guarding":0,"scanning":0,"normalizing":0,"cleaning":0,"uploading":0,"waiting_to_publish":0,"complete":0,"empty":0,"partial":0,"failed":0,"cancelled":0}'
    CHECK (json_valid(repository_totals) AND json_type(repository_totals) = 'object'),
  coverage_totals TEXT NOT NULL DEFAULT '{"snapshot":{"waiting":0,"complete":0,"not_applicable":0,"unsupported":0,"partial":0,"failed":0},"archive_guard":{"waiting":0,"complete":0,"not_applicable":0,"unsupported":0,"partial":0,"failed":0},"gitleaks":{"waiting":0,"complete":0,"not_applicable":0,"unsupported":0,"partial":0,"failed":0},"osv":{"waiting":0,"complete":0,"not_applicable":0,"unsupported":0,"partial":0,"failed":0},"zizmor":{"waiting":0,"complete":0,"not_applicable":0,"unsupported":0,"partial":0,"failed":0},"opengrep":{"waiting":0,"complete":0,"not_applicable":0,"unsupported":0,"partial":0,"failed":0}}'
    CHECK (json_valid(coverage_totals) AND json_type(coverage_totals) = 'object')
) STRICT;

CREATE TABLE repositories (
  request_id TEXT NOT NULL REFERENCES request_totals(request_id) ON DELETE CASCADE,
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
  specialist_reasons TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(specialist_reasons) AND json_type(specialist_reasons) = 'object'),
  coverage_json TEXT NOT NULL
    CHECK (json_valid(coverage_json) AND json_type(coverage_json) = 'object'),
  PRIMARY KEY (request_id, repository_id),
  CHECK (commit_sha IS NULL OR length(commit_sha) = 40),
  CHECK (
    (lease_owner IS NULL AND lease_expires_at_ms IS NULL) OR
    (lease_owner IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE finding_chunks (
  request_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  first_finding_id TEXT NOT NULL,
  last_finding_id TEXT NOT NULL,
  finding_count INTEGER NOT NULL CHECK (finding_count BETWEEN 1 AND 100),
  findings_json TEXT NOT NULL
    CHECK (
      json_valid(findings_json) AND
      json_type(findings_json) = 'array' AND
      json_array_length(findings_json) = finding_count
    ),
  FOREIGN KEY (request_id, repository_id)
    REFERENCES repositories(request_id, repository_id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, repository_id, chunk_index),
  UNIQUE (request_id, first_finding_id),
  UNIQUE (request_id, last_finding_id)
) STRICT;

CREATE TABLE worker_identities (
  worker_id TEXT PRIMARY KEY,
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE write_budget (
  utc_day TEXT PRIMARY KEY CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  modeled_writes INTEGER NOT NULL CHECK (modeled_writes >= 0)
) STRICT;

CREATE TABLE write_reservations (
  request_id TEXT NOT NULL REFERENCES scan_requests(request_id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('request','discovery')),
  utc_day TEXT NOT NULL CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  modeled_writes INTEGER NOT NULL CHECK (modeled_writes >= 1),
  PRIMARY KEY (request_id, stage)
) STRICT;

CREATE TRIGGER reserve_daily_write_budget
BEFORE INSERT ON write_reservations
BEGIN
  INSERT OR IGNORE INTO write_budget(utc_day, modeled_writes)
  VALUES (NEW.utc_day, 0);
  SELECT RAISE(ABORT, 'D1_WRITE_RESERVE')
  WHERE (
    SELECT modeled_writes FROM write_budget WHERE utc_day = NEW.utc_day
  ) + NEW.modeled_writes > 80000;
  UPDATE write_budget
  SET modeled_writes = modeled_writes + NEW.modeled_writes
  WHERE utc_day = NEW.utc_day;
END;

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
CREATE INDEX repositories_lease_owner
  ON repositories(lease_owner, lease_expires_at_ms)
  WHERE lease_owner IS NOT NULL;
CREATE INDEX finding_chunks_request_order
  ON finding_chunks(request_id, first_finding_id, last_finding_id);

CREATE TRIGGER request_totals_after_repository_update
AFTER UPDATE OF state, coverage_json ON repositories
WHEN OLD.state <> NEW.state OR OLD.coverage_json <> NEW.coverage_json
BEGIN
  UPDATE request_totals
  SET repository_totals = json_set(
      repository_totals,
      '$.discovered',
      json_extract(repository_totals, '$.discovered') + CASE WHEN NEW.state = 'discovered' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'discovered' THEN 1 ELSE 0 END,
      '$.waiting',
      json_extract(repository_totals, '$.waiting') + CASE WHEN NEW.state = 'waiting' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'waiting' THEN 1 ELSE 0 END,
      '$.leased',
      json_extract(repository_totals, '$.leased') + CASE WHEN NEW.state = 'leased' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'leased' THEN 1 ELSE 0 END,
      '$.acquiring',
      json_extract(repository_totals, '$.acquiring') + CASE WHEN NEW.state = 'acquiring' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'acquiring' THEN 1 ELSE 0 END,
      '$.guarding',
      json_extract(repository_totals, '$.guarding') + CASE WHEN NEW.state = 'guarding' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'guarding' THEN 1 ELSE 0 END,
      '$.scanning',
      json_extract(repository_totals, '$.scanning') + CASE WHEN NEW.state = 'scanning' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'scanning' THEN 1 ELSE 0 END,
      '$.normalizing',
      json_extract(repository_totals, '$.normalizing') + CASE WHEN NEW.state = 'normalizing' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'normalizing' THEN 1 ELSE 0 END,
      '$.cleaning',
      json_extract(repository_totals, '$.cleaning') + CASE WHEN NEW.state = 'cleaning' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'cleaning' THEN 1 ELSE 0 END,
      '$.uploading',
      json_extract(repository_totals, '$.uploading') + CASE WHEN NEW.state = 'uploading' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'uploading' THEN 1 ELSE 0 END,
      '$.waiting_to_publish',
      json_extract(repository_totals, '$.waiting_to_publish') + CASE WHEN NEW.state = 'waiting_to_publish' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'waiting_to_publish' THEN 1 ELSE 0 END,
      '$.complete',
      json_extract(repository_totals, '$.complete') + CASE WHEN NEW.state = 'complete' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'complete' THEN 1 ELSE 0 END,
      '$.empty',
      json_extract(repository_totals, '$.empty') + CASE WHEN NEW.state = 'empty' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'empty' THEN 1 ELSE 0 END,
      '$.partial',
      json_extract(repository_totals, '$.partial') + CASE WHEN NEW.state = 'partial' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'partial' THEN 1 ELSE 0 END,
      '$.failed',
      json_extract(repository_totals, '$.failed') + CASE WHEN NEW.state = 'failed' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'failed' THEN 1 ELSE 0 END,
      '$.cancelled',
      json_extract(repository_totals, '$.cancelled') + CASE WHEN NEW.state = 'cancelled' THEN 1 ELSE 0 END - CASE WHEN OLD.state = 'cancelled' THEN 1 ELSE 0 END
    ),
    coverage_totals = json_set(
      coverage_totals,
      '$.snapshot.waiting',
      json_extract(coverage_totals, '$.snapshot.waiting') + CASE WHEN json_extract(NEW.coverage_json, '$.snapshot') = 'waiting' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.snapshot') = 'waiting' THEN 1 ELSE 0 END,
      '$.snapshot.complete',
      json_extract(coverage_totals, '$.snapshot.complete') + CASE WHEN json_extract(NEW.coverage_json, '$.snapshot') = 'complete' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.snapshot') = 'complete' THEN 1 ELSE 0 END,
      '$.snapshot.not_applicable',
      json_extract(coverage_totals, '$.snapshot.not_applicable') + CASE WHEN json_extract(NEW.coverage_json, '$.snapshot') = 'not_applicable' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.snapshot') = 'not_applicable' THEN 1 ELSE 0 END,
      '$.snapshot.unsupported',
      json_extract(coverage_totals, '$.snapshot.unsupported') + CASE WHEN json_extract(NEW.coverage_json, '$.snapshot') = 'unsupported' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.snapshot') = 'unsupported' THEN 1 ELSE 0 END,
      '$.snapshot.partial',
      json_extract(coverage_totals, '$.snapshot.partial') + CASE WHEN json_extract(NEW.coverage_json, '$.snapshot') = 'partial' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.snapshot') = 'partial' THEN 1 ELSE 0 END,
      '$.snapshot.failed',
      json_extract(coverage_totals, '$.snapshot.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.snapshot') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.snapshot') = 'failed' THEN 1 ELSE 0 END,
      '$.archive_guard.waiting',
      json_extract(coverage_totals, '$.archive_guard.waiting') + CASE WHEN json_extract(NEW.coverage_json, '$.archive_guard') = 'waiting' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.archive_guard') = 'waiting' THEN 1 ELSE 0 END,
      '$.archive_guard.complete',
      json_extract(coverage_totals, '$.archive_guard.complete') + CASE WHEN json_extract(NEW.coverage_json, '$.archive_guard') = 'complete' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.archive_guard') = 'complete' THEN 1 ELSE 0 END,
      '$.archive_guard.not_applicable',
      json_extract(coverage_totals, '$.archive_guard.not_applicable') + CASE WHEN json_extract(NEW.coverage_json, '$.archive_guard') = 'not_applicable' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.archive_guard') = 'not_applicable' THEN 1 ELSE 0 END,
      '$.archive_guard.unsupported',
      json_extract(coverage_totals, '$.archive_guard.unsupported') + CASE WHEN json_extract(NEW.coverage_json, '$.archive_guard') = 'unsupported' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.archive_guard') = 'unsupported' THEN 1 ELSE 0 END,
      '$.archive_guard.partial',
      json_extract(coverage_totals, '$.archive_guard.partial') + CASE WHEN json_extract(NEW.coverage_json, '$.archive_guard') = 'partial' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.archive_guard') = 'partial' THEN 1 ELSE 0 END,
      '$.archive_guard.failed',
      json_extract(coverage_totals, '$.archive_guard.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.archive_guard') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.archive_guard') = 'failed' THEN 1 ELSE 0 END,
      '$.gitleaks.waiting',
      json_extract(coverage_totals, '$.gitleaks.waiting') + CASE WHEN json_extract(NEW.coverage_json, '$.gitleaks') = 'waiting' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.gitleaks') = 'waiting' THEN 1 ELSE 0 END,
      '$.gitleaks.complete',
      json_extract(coverage_totals, '$.gitleaks.complete') + CASE WHEN json_extract(NEW.coverage_json, '$.gitleaks') = 'complete' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.gitleaks') = 'complete' THEN 1 ELSE 0 END,
      '$.gitleaks.not_applicable',
      json_extract(coverage_totals, '$.gitleaks.not_applicable') + CASE WHEN json_extract(NEW.coverage_json, '$.gitleaks') = 'not_applicable' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.gitleaks') = 'not_applicable' THEN 1 ELSE 0 END,
      '$.gitleaks.unsupported',
      json_extract(coverage_totals, '$.gitleaks.unsupported') + CASE WHEN json_extract(NEW.coverage_json, '$.gitleaks') = 'unsupported' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.gitleaks') = 'unsupported' THEN 1 ELSE 0 END,
      '$.gitleaks.partial',
      json_extract(coverage_totals, '$.gitleaks.partial') + CASE WHEN json_extract(NEW.coverage_json, '$.gitleaks') = 'partial' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.gitleaks') = 'partial' THEN 1 ELSE 0 END,
      '$.gitleaks.failed',
      json_extract(coverage_totals, '$.gitleaks.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.gitleaks') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.gitleaks') = 'failed' THEN 1 ELSE 0 END,
      '$.osv.waiting',
      json_extract(coverage_totals, '$.osv.waiting') + CASE WHEN json_extract(NEW.coverage_json, '$.osv') = 'waiting' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.osv') = 'waiting' THEN 1 ELSE 0 END,
      '$.osv.complete',
      json_extract(coverage_totals, '$.osv.complete') + CASE WHEN json_extract(NEW.coverage_json, '$.osv') = 'complete' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.osv') = 'complete' THEN 1 ELSE 0 END,
      '$.osv.not_applicable',
      json_extract(coverage_totals, '$.osv.not_applicable') + CASE WHEN json_extract(NEW.coverage_json, '$.osv') = 'not_applicable' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.osv') = 'not_applicable' THEN 1 ELSE 0 END,
      '$.osv.unsupported',
      json_extract(coverage_totals, '$.osv.unsupported') + CASE WHEN json_extract(NEW.coverage_json, '$.osv') = 'unsupported' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.osv') = 'unsupported' THEN 1 ELSE 0 END,
      '$.osv.partial',
      json_extract(coverage_totals, '$.osv.partial') + CASE WHEN json_extract(NEW.coverage_json, '$.osv') = 'partial' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.osv') = 'partial' THEN 1 ELSE 0 END,
      '$.osv.failed',
      json_extract(coverage_totals, '$.osv.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.osv') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.osv') = 'failed' THEN 1 ELSE 0 END,
      '$.zizmor.waiting',
      json_extract(coverage_totals, '$.zizmor.waiting') + CASE WHEN json_extract(NEW.coverage_json, '$.zizmor') = 'waiting' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.zizmor') = 'waiting' THEN 1 ELSE 0 END,
      '$.zizmor.complete',
      json_extract(coverage_totals, '$.zizmor.complete') + CASE WHEN json_extract(NEW.coverage_json, '$.zizmor') = 'complete' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.zizmor') = 'complete' THEN 1 ELSE 0 END,
      '$.zizmor.not_applicable',
      json_extract(coverage_totals, '$.zizmor.not_applicable') + CASE WHEN json_extract(NEW.coverage_json, '$.zizmor') = 'not_applicable' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.zizmor') = 'not_applicable' THEN 1 ELSE 0 END,
      '$.zizmor.unsupported',
      json_extract(coverage_totals, '$.zizmor.unsupported') + CASE WHEN json_extract(NEW.coverage_json, '$.zizmor') = 'unsupported' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.zizmor') = 'unsupported' THEN 1 ELSE 0 END,
      '$.zizmor.partial',
      json_extract(coverage_totals, '$.zizmor.partial') + CASE WHEN json_extract(NEW.coverage_json, '$.zizmor') = 'partial' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.zizmor') = 'partial' THEN 1 ELSE 0 END,
      '$.zizmor.failed',
      json_extract(coverage_totals, '$.zizmor.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.zizmor') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.zizmor') = 'failed' THEN 1 ELSE 0 END,
      '$.opengrep.waiting',
      json_extract(coverage_totals, '$.opengrep.waiting') + CASE WHEN json_extract(NEW.coverage_json, '$.opengrep') = 'waiting' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.opengrep') = 'waiting' THEN 1 ELSE 0 END,
      '$.opengrep.complete',
      json_extract(coverage_totals, '$.opengrep.complete') + CASE WHEN json_extract(NEW.coverage_json, '$.opengrep') = 'complete' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.opengrep') = 'complete' THEN 1 ELSE 0 END,
      '$.opengrep.not_applicable',
      json_extract(coverage_totals, '$.opengrep.not_applicable') + CASE WHEN json_extract(NEW.coverage_json, '$.opengrep') = 'not_applicable' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.opengrep') = 'not_applicable' THEN 1 ELSE 0 END,
      '$.opengrep.unsupported',
      json_extract(coverage_totals, '$.opengrep.unsupported') + CASE WHEN json_extract(NEW.coverage_json, '$.opengrep') = 'unsupported' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.opengrep') = 'unsupported' THEN 1 ELSE 0 END,
      '$.opengrep.partial',
      json_extract(coverage_totals, '$.opengrep.partial') + CASE WHEN json_extract(NEW.coverage_json, '$.opengrep') = 'partial' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.opengrep') = 'partial' THEN 1 ELSE 0 END,
      '$.opengrep.failed',
      json_extract(coverage_totals, '$.opengrep.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.opengrep') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.opengrep') = 'failed' THEN 1 ELSE 0 END
    )
  WHERE request_id = NEW.request_id;
END;
