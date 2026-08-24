-- Deep-read slot mark, written at discovery completion: 1 when the repository
-- won one of the request's deep-read slots (most recently pushed first), 0
-- when it lost, NULL on rows from before the ranking existed, which the
-- worker treats as its old first-claimed-first-read behaviour. Nullable and
-- additive on purpose; this table has been rebuilt exactly once and that
-- migration class caused an outage.
ALTER TABLE repositories
  ADD COLUMN ai_eligible INTEGER
  CHECK (ai_eligible IS NULL OR ai_eligible IN (0,1));
