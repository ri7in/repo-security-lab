#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" != "1" || "$1" == -* ]]; then
  echo "usage: deploy-to-host.sh user@host" >&2
  exit 64
fi

host="$1"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository_root"
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:scan-domain
pnpm build:scan-worker

ssh "$host" "sudo install -d -o root -g root -m 0755 /opt/repository-security/app"
rsync --archive --relative \
  --rsync-path="sudo rsync" \
  apps/scan-domain/dist/scan-domain.mjs \
  apps/scan-worker/dist/server.mjs \
  packages/scanners/config/gitleaks.toml \
  packages/scanners/config/gitleaks.ignore \
  deploy/oci/bootstrap-ubuntu.sh \
  deploy/oci/repository-security-worker.service \
  deploy/oci/worker.env.example \
  "$host:/opt/repository-security/app/"
ssh "$host" "sudo /opt/repository-security/app/deploy/oci/bootstrap-ubuntu.sh"
