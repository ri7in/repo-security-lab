-- On-demand worker dispatch ledger.
--
-- One row per UTC day. Bounds how many GitHub Actions runs a day of traffic
-- can start, and spaces them out so a burst of visitors collapses into a
-- single run rather than one run each. Counters only: no visitor, username,
-- or request identifier is recorded here.
CREATE TABLE worker_dispatch (
  utc_day TEXT PRIMARY KEY CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  dispatches INTEGER NOT NULL DEFAULT 0 CHECK (dispatches >= 0),
  last_dispatch_ms INTEGER NOT NULL DEFAULT 0 CHECK (last_dispatch_ms >= 0)
) STRICT;
