CREATE INDEX scan_requests_terminal_retention
  ON scan_requests(updated_at_ms, request_id)
  WHERE state IN ('complete','failed');
