# OCI Always Free worker

This is the selected $0 continuous scan-compute path. It targets one Ubuntu
ARM64 VM on OCI's Always Free A1 allocation. The host process may reach GitHub
and the control plane, but archive extraction and scanning run in a separate
bubblewrap namespace with no network, no host credentials, no ambient
environment, read-only trusted tools, and a strict numeric output contract.
The host bundle includes pinned Gitleaks and Zizmor ARM64 binaries; the workflow
lane stays unavailable everywhere that cannot pass the same isolation proof.

The bootstrap installs and loads Ubuntu's packaged
`bwrap-userns-restrict` AppArmor profile. Do not disable Ubuntu's global
`kernel.apparmor_restrict_unprivileged_userns` safeguard: the narrow profile is
what grants Bubblewrap only the namespace operations needed by this worker.

## Owner actions

1. Create or sign in to an OCI Free Tier account. The home region is permanent,
   so choose a region where an Always Free A1 Flex shape is available. Create
   an Ubuntu ARM64 VM within the Always Free allocation and add your SSH key.
   Do not upgrade the account or select a paid shape.
2. From this repository, run:

   ```sh
   deploy/oci/deploy-to-host.sh ubuntu@VM_IP
   ```

3. Provision a new worker ID in D1 and derive its generation-1 secret from the
   same `WORKER_AUTH_MASTER_SECRET` installed in Cloudflare. Put only the
   derived worker secret, not the master secret, into
   `/etc/repository-security/worker.env` with `sudoedit`. The file is root-only.
4. Keep `PUBLIC_WORKER=false` for the first operator-account proof. Then run:

   ```sh
   sudo systemctl enable --now repository-security-worker
   sudo systemctl status repository-security-worker --no-pager
   sudo journalctl -u repository-security-worker --since today --no-pager
   ```

   Startup fails closed unless the real in-namespace escape probe proves that
   networking is denied, credential paths are hidden, writes outside mounted
   scratch are denied, and the environment contains only the fixed allowlist.
5. After a private synthetic request completes and scratch is empty, set
   `PUBLIC_WORKER=true`, remove `PRIVATE_SLICE_ACCOUNT_IDS`, restart, and prove a
   second synthetic request. Only then change `PUBLIC_SCANNING_ENABLED=true` in
   the Cloudflare deployment and run the live abuse/load gate.

## Fail-closed behavior

- The service is disabled after bootstrap and cannot start with placeholder
  credentials.
- systemd runs a non-login user with no capabilities, a read-only host
  filesystem, private devices/tmp, no swap, a 2 GiB memory ceiling, 1.5 CPU
  ceiling, and 128-task ceiling.
- A public worker constructor refuses to exist until bubblewrap verification
  and the escape probe have passed.
- Scanner output is accepted only through strict schemas containing numeric
  manifest tokens and count buckets. Any free-form extra field rejects the
  result.
- The service is sequential by default; a crash leaves tuple-keyed scratch for
  startup cleanup and lease recovery.

The OCI account, VM, SSH access, and worker credential are the only external
owner blockers. Everything else in this directory is deployable without a
domain, Docker, or a paid service.
