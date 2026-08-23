#!/usr/bin/env bash
# Who has used the scanner, and when.
#
# Reads the production ledger directly. There is no admin page and no admin
# login, deliberately: an operator-only web route is another public attack
# surface on a service whose whole selling point is that it holds nothing
# sensitive. A local query needs the Cloudflare credential you already have.
#
# Usage:
#   deploy/usage-log.sh              last 50 scans
#   deploy/usage-log.sh 200          last 200 scans
#   deploy/usage-log.sh 50 summary   totals by day and country instead
#
# What is recorded: the submitted username, the resolved GitHub account id, the
# outcome, timestamps, and a two-letter country resolved by Cloudflare at the
# edge. No IP address is stored anywhere, which is what the privacy page says.

set -euo pipefail

cd "$(dirname "$0")/.."

LIMIT="${1:-50}"
MODE="${2:-recent}"

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "error: first argument must be a number of rows" >&2
  exit 2
fi

case "$MODE" in
  recent)
    SQL="SELECT
           datetime(created_at_ms/1000,'unixepoch') AS started_utc,
           username,
           COALESCE(country,'--') AS country,
           state,
           COALESCE(reason,'') AS reason,
           COALESCE(github_account_id,'') AS account_id,
           ROUND((updated_at_ms-created_at_ms)/1000.0,1) AS seconds
         FROM scan_requests
         ORDER BY created_at_ms DESC
         LIMIT ${LIMIT};"
    ;;
  summary)
    SQL="SELECT
           date(created_at_ms/1000,'unixepoch') AS day,
           COALESCE(country,'--') AS country,
           COUNT(*) AS scans,
           COUNT(DISTINCT username) AS distinct_users,
           SUM(state='complete') AS completed,
           SUM(state='failed') AS failed
         FROM scan_requests
         GROUP BY day, country
         ORDER BY day DESC, scans DESC
         LIMIT ${LIMIT};"
    ;;
  *)
    echo "error: mode must be 'recent' or 'summary'" >&2
    exit 2
    ;;
esac

# Wrangler prints a wrapped JSON envelope. Formatting it is the difference
# between a log you read and one you skim past.
npx --no-install wrangler d1 execute repo-security-lab \
  --remote --json \
  --config apps/control-plane/wrangler.jsonc \
  --command "${SQL}" \
| python3 "$(dirname "$0")/format-rows.py"
