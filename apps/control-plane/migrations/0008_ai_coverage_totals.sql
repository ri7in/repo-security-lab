-- The AI engine's coverage totals never moved.
--
-- `ai` was added to SPECIALISTS as a fifth scan engine, so a new request
-- starts with an `ai` bucket holding every repository as `waiting`, and the
-- trigger that keeps request_totals in step was written before it existed and
-- has no arm for it. A finished twenty-three repository request therefore
-- reported, through the public API, that all twenty-three AI checks were still
-- waiting, while its own repository rows said two complete, one failed,
-- sixteen unsupported and four not applicable.
--
-- SQLite cannot alter a trigger, so it is dropped and recreated with the six
-- `ai` arms the other five engines already have. Then every request that
-- already exists is recomputed from its own rows, because a counter that has
-- been wrong since the row was written does not fix itself by counting the
-- next change correctly.

DROP TRIGGER request_totals_after_repository_update;

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
      json_extract(coverage_totals, '$.opengrep.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.opengrep') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.opengrep') = 'failed' THEN 1 ELSE 0 END,
      '$.ai.waiting',
      json_extract(coverage_totals, '$.ai.waiting') + CASE WHEN json_extract(NEW.coverage_json, '$.ai') = 'waiting' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.ai') = 'waiting' THEN 1 ELSE 0 END,
      '$.ai.complete',
      json_extract(coverage_totals, '$.ai.complete') + CASE WHEN json_extract(NEW.coverage_json, '$.ai') = 'complete' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.ai') = 'complete' THEN 1 ELSE 0 END,
      '$.ai.not_applicable',
      json_extract(coverage_totals, '$.ai.not_applicable') + CASE WHEN json_extract(NEW.coverage_json, '$.ai') = 'not_applicable' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.ai') = 'not_applicable' THEN 1 ELSE 0 END,
      '$.ai.unsupported',
      json_extract(coverage_totals, '$.ai.unsupported') + CASE WHEN json_extract(NEW.coverage_json, '$.ai') = 'unsupported' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.ai') = 'unsupported' THEN 1 ELSE 0 END,
      '$.ai.partial',
      json_extract(coverage_totals, '$.ai.partial') + CASE WHEN json_extract(NEW.coverage_json, '$.ai') = 'partial' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.ai') = 'partial' THEN 1 ELSE 0 END,
      '$.ai.failed',
      json_extract(coverage_totals, '$.ai.failed') + CASE WHEN json_extract(NEW.coverage_json, '$.ai') = 'failed' THEN 1 ELSE 0 END - CASE WHEN json_extract(OLD.coverage_json, '$.ai') = 'failed' THEN 1 ELSE 0 END
    )
  WHERE request_id = NEW.request_id;
END;

UPDATE request_totals
SET coverage_totals = json_set(
    coverage_totals,

    '$.ai.waiting',
    (SELECT COUNT(*) FROM repositories r WHERE r.request_id = request_totals.request_id AND json_extract(r.coverage_json, '$.ai') = 'waiting'),
    '$.ai.complete',
    (SELECT COUNT(*) FROM repositories r WHERE r.request_id = request_totals.request_id AND json_extract(r.coverage_json, '$.ai') = 'complete'),
    '$.ai.not_applicable',
    (SELECT COUNT(*) FROM repositories r WHERE r.request_id = request_totals.request_id AND json_extract(r.coverage_json, '$.ai') = 'not_applicable'),
    '$.ai.unsupported',
    (SELECT COUNT(*) FROM repositories r WHERE r.request_id = request_totals.request_id AND json_extract(r.coverage_json, '$.ai') = 'unsupported'),
    '$.ai.partial',
    (SELECT COUNT(*) FROM repositories r WHERE r.request_id = request_totals.request_id AND json_extract(r.coverage_json, '$.ai') = 'partial'),
    '$.ai.failed',
    (SELECT COUNT(*) FROM repositories r WHERE r.request_id = request_totals.request_id AND json_extract(r.coverage_json, '$.ai') = 'failed')
  );
