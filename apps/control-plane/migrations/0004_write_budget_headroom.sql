DROP TRIGGER reserve_daily_write_budget;

CREATE TRIGGER reserve_daily_write_budget
BEFORE INSERT ON write_reservations
BEGIN
  INSERT OR IGNORE INTO write_budget(utc_day, modeled_writes)
  VALUES (NEW.utc_day, 0);
  SELECT RAISE(ABORT, 'D1_WRITE_RESERVE')
  WHERE (
    SELECT modeled_writes FROM write_budget WHERE utc_day = NEW.utc_day
  ) + NEW.modeled_writes > 40000;
  UPDATE write_budget
  SET modeled_writes = modeled_writes + NEW.modeled_writes
  WHERE utc_day = NEW.utc_day;
END;

CREATE TABLE daily_request_admission (
  utc_day TEXT PRIMARY KEY CHECK (utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  accepted_requests INTEGER NOT NULL CHECK (accepted_requests BETWEEN 0 AND 240)
) STRICT;

CREATE TRIGGER cap_daily_request_admission
BEFORE INSERT ON scan_requests
BEGIN
  INSERT OR IGNORE INTO daily_request_admission(utc_day, accepted_requests)
  VALUES (strftime('%Y-%m-%d', NEW.created_at_ms / 1000, 'unixepoch'), 0);
  SELECT RAISE(ABORT, 'D1_WRITE_RESERVE')
  WHERE (
    SELECT accepted_requests FROM daily_request_admission
    WHERE utc_day = strftime('%Y-%m-%d', NEW.created_at_ms / 1000, 'unixepoch')
  ) >= 240;
  UPDATE daily_request_admission
  SET accepted_requests = accepted_requests + 1
  WHERE utc_day = strftime('%Y-%m-%d', NEW.created_at_ms / 1000, 'unixepoch');
END;
