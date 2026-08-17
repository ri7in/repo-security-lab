CREATE TABLE scan_notifications (
  request_id TEXT PRIMARY KEY REFERENCES scan_requests(request_id) ON DELETE CASCADE,
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash) = 43),
  recipient_ciphertext TEXT NOT NULL,
  recipient_iv TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
  claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR claimed_at_ms >= 0),
  sent_at_ms INTEGER CHECK (sent_at_ms IS NULL OR sent_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (
    length(recipient_ciphertext) BETWEEN 16 AND 512 OR
    (state IN ('sent','failed') AND recipient_ciphertext = '')
  ),
  CHECK (
    length(recipient_iv) = 16 OR
    (state IN ('sent','failed') AND recipient_iv = '')
  ),
  CHECK ((state = 'sending') = (claimed_at_ms IS NOT NULL)),
  CHECK ((state = 'sent') = (sent_at_ms IS NOT NULL))
) STRICT;

CREATE INDEX scan_notifications_delivery
  ON scan_notifications(state, next_attempt_at_ms, created_at_ms);
CREATE INDEX scan_notifications_recipient_window
  ON scan_notifications(recipient_hash, created_at_ms);

CREATE TRIGGER scan_notifications_hard_quota
BEFORE INSERT ON scan_notifications
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_RATE_LIMIT')
  WHERE (
    SELECT COUNT(*) FROM scan_notifications
    WHERE created_at_ms >= NEW.created_at_ms - 86400000
  ) >= 80;
  SELECT RAISE(ABORT, 'NOTIFICATION_RECIPIENT_LIMIT')
  WHERE EXISTS (
    SELECT 1 FROM scan_notifications
    WHERE recipient_hash = NEW.recipient_hash
      AND created_at_ms >= NEW.created_at_ms - 86400000
  );
END;
