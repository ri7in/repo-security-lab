#!/usr/bin/env bash
# Completes the public launch.
#
# Everything before this point is done: code committed and pushed, CI green,
# D1 migrations applied, and a real 22-repository scan proven through the
# public GitHub Actions worker with enforced Bubblewrap isolation.
#
# Three steps remain, and each needs a credential or an irreversible action
# that only the repository owner can perform.
#
# Usage:
#   deploy/finish-launch.sh <github-actions-write-token>
#
# The token must be a fine-grained personal access token scoped to this one
# repository with Actions: Read and write. Nothing else. Create it at
# https://github.com/settings/personal-access-tokens/new
#
# Do not pass an account-wide classic token here. It ends up as a Cloudflare
# Worker secret, and a token that can also delete repositories does not belong
# in a web service.

set -euo pipefail

REPO="ri7in/repo-security-lab"
WORKFLOW="trusted-scan-worker.yml"
ORIGIN="https://repo-security-lab.rivinsand.workers.dev"

cd "$(dirname "$0")/.."

DISPATCH_TOKEN="${1:-}"
if [ -z "$DISPATCH_TOKEN" ]; then
  echo "error: pass the GitHub Actions dispatch token as the first argument" >&2
  exit 2
fi

echo "==> 1/6 checking the token can start a workflow run, and nothing more"
# A fine-grained token limited to Actions cannot read repository settings.
# Confirm it CAN dispatch before anything is changed.
dispatch_status="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "authorization: Bearer $DISPATCH_TOKEN" \
  -H "accept: application/vnd.github+json" \
  -H "x-github-api-version: 2022-11-28" \
  -H "content-type: application/json" \
  -d '{"ref":"main"}' \
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches")"
if [ "$dispatch_status" != "204" ]; then
  echo "error: token cannot dispatch the worker (HTTP $dispatch_status)" >&2
  echo "       it needs Actions: Read and write on $REPO" >&2
  exit 1
fi
echo "    ok, workflow dispatch accepted"

echo "==> 2/6 storing the dispatch token as a Worker secret"
printf '%s' "$DISPATCH_TOKEN" | \
  npx --no-install wrangler secret put WORKER_DISPATCH_TOKEN \
  --config apps/control-plane/wrangler.jsonc

echo "==> 3/6 turning on public scanning and on-demand dispatch"
npx --no-install wrangler deploy \
  --config apps/control-plane/wrangler.jsonc \
  --var PUBLIC_SCANNING_ENABLED:true \
  --var "WORKER_DISPATCH_REPOSITORY:$REPO" \
  --var "WORKER_DISPATCH_WORKFLOW:$WORKFLOW" \
  --var WORKER_DISPATCH_REF:main

echo "==> 4/6 making the repository public"
# Unlimited free Actions minutes apply to public repositories only, which is
# what makes the on-demand worker cost nothing to run.
gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences

echo "==> 5/6 verifying the live site"
caps="$(curl -s --max-time 20 "$ORIGIN/api/capabilities")"
echo "    capabilities: $caps"
case "$caps" in
  *'"scanCreation":"public"'*) echo "    ok, public scanning is live" ;;
  *) echo "error: site still reports private preview" >&2; exit 1 ;;
esac

echo "==> 6/6 proving a stranger can now scan"
# octocat is not the operator account. Before launch this returned 403.
octocat="$(curl -s --max-time 30 -X POST -H 'content-type: application/json' \
  -d '{"username":"octocat"}' "$ORIGIN/api/scan-requests")"
echo "    octocat: $octocat"
case "$octocat" in
  *requestId*) echo "    ok, third-party scan accepted and a worker was dispatched" ;;
  *) echo "error: third-party scan was refused" >&2; exit 1 ;;
esac

echo
echo "Launched. Watch the run at https://github.com/$REPO/actions"
echo "Report will appear at $ORIGIN/?request=<requestId above>"
