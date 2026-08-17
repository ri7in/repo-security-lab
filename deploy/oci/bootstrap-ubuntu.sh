#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "run as root" >&2
  exit 64
fi
if [[ "$(uname -m)" != "aarch64" ]]; then
  echo "this bootstrap is pinned for OCI A1 ARM64" >&2
  exit 64
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_version="24.19.0"
node_archive="node-v${node_version}-linux-arm64.tar.xz"
node_archive_sha256="01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc"
gitleaks_archive="gitleaks_8.30.1_linux_arm64.tar.gz"
gitleaks_archive_sha256="e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"
gitleaks_binary_sha256="00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b"
zizmor_archive="zizmor-aarch64-unknown-linux-gnu.tar.gz"
zizmor_archive_sha256="415eaa7c0a06479a701b8e44a3e812c1047decc848ec4bede7bd6bbf49f22d20"
zizmor_binary_sha256="774a1b9fa2514a5645a9cf7f374f24bd538468436db1be1dd76000ffa8567902"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends bubblewrap ca-certificates curl tar xz-utils

if ! id repo-security >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/repository-security --shell /usr/sbin/nologin repo-security
fi
install -d -o root -g root -m 0755 /opt/repository-security /opt/repository-security/tools
install -d -o repo-security -g repo-security -m 0700 /var/lib/repository-security/scratch
install -d -o root -g root -m 0700 /etc/repository-security

curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors --connect-timeout 10 --max-time 180 \
  --output "$temporary/$node_archive" \
  "https://nodejs.org/dist/v${node_version}/${node_archive}"
echo "$node_archive_sha256  $temporary/$node_archive" | sha256sum --check --strict
install -d -o root -g root -m 0755 "/opt/repository-security/node-v${node_version}"
tar --extract --xz --file "$temporary/$node_archive" \
  --directory "/opt/repository-security/node-v${node_version}" --strip-components=1
ln -sfn "node-v${node_version}" /opt/repository-security/node

curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors --connect-timeout 10 --max-time 180 \
  --output "$temporary/$gitleaks_archive" \
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/${gitleaks_archive}"
echo "$gitleaks_archive_sha256  $temporary/$gitleaks_archive" | sha256sum --check --strict
tar --extract --gzip --file "$temporary/$gitleaks_archive" --directory "$temporary" gitleaks
echo "$gitleaks_binary_sha256  $temporary/gitleaks" | sha256sum --check --strict
install -o root -g root -m 0755 "$temporary/gitleaks" /opt/repository-security/tools/gitleaks

curl --fail --silent --show-error --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors --connect-timeout 10 --max-time 180 \
  --output "$temporary/$zizmor_archive" \
  "https://github.com/zizmorcore/zizmor/releases/download/v1.29.0/${zizmor_archive}"
echo "$zizmor_archive_sha256  $temporary/$zizmor_archive" | sha256sum --check --strict
tar --extract --gzip --file "$temporary/$zizmor_archive" --directory "$temporary" zizmor
echo "$zizmor_binary_sha256  $temporary/zizmor" | sha256sum --check --strict
install -o root -g root -m 0755 "$temporary/zizmor" /opt/repository-security/tools/zizmor

install -o root -g root -m 0644 \
  "$script_dir/repository-security-worker.service" \
  /etc/systemd/system/repository-security-worker.service
if [[ ! -e /etc/repository-security/worker.env ]]; then
  install -o root -g root -m 0600 \
    "$script_dir/worker.env.example" /etc/repository-security/worker.env
fi

test "$(stat --format='%U:%G:%a' /usr/bin/bwrap)" = "root:root:755"
test "$(sha256sum /opt/repository-security/tools/gitleaks | cut -d' ' -f1)" = "$gitleaks_binary_sha256"
test "$(sha256sum /opt/repository-security/tools/zizmor | cut -d' ' -f1)" = "$zizmor_binary_sha256"
/opt/repository-security/node/bin/node --version | grep --fixed-strings "v${node_version}"
systemd-analyze verify /etc/systemd/system/repository-security-worker.service
systemctl daemon-reload
systemctl disable repository-security-worker.service >/dev/null 2>&1 || true
echo "host prepared; edit /etc/repository-security/worker.env before enabling the service"
