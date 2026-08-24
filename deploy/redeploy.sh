#!/usr/bin/env bash
# Ships the current build to the live worker.
#
# The four variables below are passed on every deploy, and have to be. Wrangler
# replaces the deployed environment with whatever the config and the flags say,
# and the checked-in config keeps PUBLIC_SCANNING_ENABLED off on purpose so
# that a fresh clone cannot open the service by accident. A plain
# `wrangler deploy` therefore turns public scanning off and unhooks the worker
# dispatch, which looks like the site breaking for no reason.
#
# The dispatch token is a Worker secret and is not touched here. Secrets
# survive a deploy; variables do not.
#
# Usage: deploy/redeploy.sh

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="ri7in/repo-security-lab"
WORKFLOW="trusted-scan-worker.yml"
ORIGIN="https://repo-security-lab.rivinsand.workers.dev"

echo "==> building the web bundle"
pnpm build

echo "==> applying any new D1 migrations"
npx --no-install wrangler d1 migrations apply DB \
  --remote \
  --config apps/control-plane/wrangler.jsonc

echo "==> deploying the control plane and the site"
npx --no-install wrangler deploy \
  --config apps/control-plane/wrangler.jsonc \
  --var PUBLIC_SCANNING_ENABLED:true \
  --var "WORKER_DISPATCH_REPOSITORY:$REPO" \
  --var "WORKER_DISPATCH_WORKFLOW:$WORKFLOW" \
  --var WORKER_DISPATCH_REF:main

echo "==> verifying the live site"
caps="$(curl -s --max-time 20 "$ORIGIN/api/capabilities")"
echo "    capabilities: $caps"
case "$caps" in
  *'"scanCreation":"public"'*) echo "    ok, public scanning is live" ;;
  *) echo "    PUBLIC SCANNING IS OFF. Check the deploy output above." >&2; exit 1 ;;
esac

# The bundle the browser is served has to be the bundle that was just built.
# A deploy that uploads the worker but not the assets, or one that races the
# asset upload, leaves the site running yesterday's JavaScript while every
# other check here passes.
local_bundle="$(ls apps/web/dist/assets/*.js | head -1)"
remote_path="$(curl -s --max-time 20 "$ORIGIN/" | grep -o '/assets/[^"]*\.js' | head -1)"
local_hash="$(shasum -a 256 "$local_bundle" | cut -d' ' -f1)"
remote_hash="$(curl -s --max-time 30 "$ORIGIN$remote_path" | shasum -a 256 | cut -d' ' -f1)"
if [ "$local_hash" = "$remote_hash" ]; then
  echo "    ok, the served bundle matches the build ($(basename "$local_bundle"))"
else
  echo "    SERVED BUNDLE DOES NOT MATCH THE BUILD." >&2
  echo "    built  $(basename "$local_bundle") $local_hash" >&2
  echo "    served $remote_path $remote_hash" >&2
  exit 1
fi
