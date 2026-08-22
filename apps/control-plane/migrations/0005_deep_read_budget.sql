-- Per-model, per-UTC-day council spend.
--
-- One row per model per day. Rows older than the retention window are removed
-- by the same cron that purges reports, so this table cannot grow without
-- bound. It records counters only: no prompt, no repository reference, and no
-- provider credential ever lands here.
CREATE TABLE deep_read_spend (
  utc_day TEXT NOT NULL CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 64),
  spent_tokens INTEGER NOT NULL DEFAULT 0 CHECK (spent_tokens >= 0),
  spent_requests INTEGER NOT NULL DEFAULT 0 CHECK (spent_requests >= 0),
  PRIMARY KEY (utc_day, model_id)
) STRICT;
