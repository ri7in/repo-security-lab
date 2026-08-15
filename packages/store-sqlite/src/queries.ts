/**
 * One-statement claim used by the adapter and the independent-connection race
 * test. The sender cannot select an already leased row: both candidate and
 * conditional UPDATE require waiting + no owner, and generation increments in
 * the same SQLite write statement.
 */
export const MAX_LEASE_ATTEMPTS = 3;

export const CLAIM_NEXT_SQL = `WITH candidate AS (
  SELECT repositories.request_id, repositories.repository_id
  FROM repositories
  INNER JOIN scan_requests
    ON scan_requests.request_id = repositories.request_id
  WHERE repositories.state = 'waiting'
    AND repositories.lease_owner IS NULL
    AND repositories.attempt_count < ${MAX_LEASE_ATTEMPTS}
    AND scan_requests.state = 'scanning'
  ORDER BY repositories.attempt_count ASC,
           repositories.repository_id ASC,
           repositories.request_id ASC
  LIMIT 1
)
UPDATE repositories
SET state = 'leased', lease_owner = ?,
    lease_generation = lease_generation + 1,
    lease_expires_at_ms = ?, attempt_count = attempt_count + 1,
    updated_at_ms = ?
WHERE state = 'waiting' AND lease_owner IS NULL
  AND EXISTS (
    SELECT 1 FROM candidate
    WHERE candidate.request_id = repositories.request_id
      AND candidate.repository_id = repositories.repository_id
  )
RETURNING *`;
