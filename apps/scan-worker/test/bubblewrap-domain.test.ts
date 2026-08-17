import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScannerCommandRunner } from "@app/scanners";
import { BubblewrapRepositoryScanDomain } from "../src/bubblewrap-domain.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  archive: string;
  source: string;
  paths: Record<"bwrap" | "node" | "bundle" | "gitleaks" | "zizmor" | "config" | "ignore", string>;
  libraries: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-bwrap-"));
  roots.push(root);
  const job = path.join(root, "job");
  await mkdir(job, { mode: 0o700 });
  const paths = {
    bwrap: path.join(root, "bwrap"),
    node: path.join(root, "node"),
    bundle: path.join(root, "scan-domain.mjs"),
    gitleaks: path.join(root, "gitleaks"),
    zizmor: path.join(root, "zizmor"),
    config: path.join(root, "gitleaks.toml"),
    ignore: path.join(root, "gitleaks.ignore"),
  };
  for (const [name, filename] of Object.entries(paths)) {
    await writeFile(filename, name, { mode: name === "config" || name === "ignore" ? 0o600 : 0o700 });
    await chmod(filename, name === "config" || name === "ignore" ? 0o600 : 0o700);
  }
  const libraries = path.join(root, "libraries");
  await mkdir(libraries, { mode: 0o755 });
  const archive = path.join(job, "inbound.tar.gz");
  await writeFile(archive, "fixture", { mode: 0o600 });
  return { root, archive, source: path.join(job, "source"), paths, libraries };
}

function outputDirectory(args: readonly string[]): string {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === "--bind" && args[index + 2] === "/output") {
      return args[index + 1] ?? "";
    }
  }
  throw new Error("missing output bind");
}

describe("bubblewrap scan domain", () => {
  it("uses a closed no-network namespace and accepts only strict numeric output", async () => {
    const files = await fixture();
    const calls: string[][] = [];
    const runCommand: ScannerCommandRunner = async (_executable, args) => {
      calls.push([...args]);
      if (args[0] === "--version") {
        return { stdout: Buffer.from("bubblewrap 0.11.0\n"), stderr: Buffer.alloc(0) };
      }
      const mode = args.at(-1);
      if (mode === "probe") {
        await writeFile(
          path.join(outputDirectory(args), "result.json"),
          JSON.stringify({
            schemaVersion: 1,
            networkDenied: true,
            credentialPathsHidden: true,
            outsideWriteDenied: true,
            environmentClean: true,
          }),
        );
      } else if (mode === "guard") {
        await mkdir(files.source, { mode: 0o700 });
        await writeFile(path.join(outputDirectory(args), "result.json"), '{"ok":true}');
      } else {
        await writeFile(
          path.join(outputDirectory(args), "result.json"),
          JSON.stringify({
            schemaVersion: 1,
            applicability: { osv: false, zizmor: true, opengrep: false },
            engineResults: [
              {
                engine: "gitleaks",
                coverage: "complete",
                reason: null,
                packet: { schemaVersion: 1, groups: [{ token: 1, bucket: 0 }] },
              },
            ],
            engineFailures: {},
          }),
        );
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const domain = new BubblewrapRepositoryScanDomain({
      bubblewrapPath: files.paths.bwrap,
      nodePath: files.paths.node,
      applicationBundlePath: files.paths.bundle,
      gitleaksBinaryPath: files.paths.gitleaks,
      gitleaksConfigPath: files.paths.config,
      gitleaksIgnorePath: files.paths.ignore,
      gitleaksSha256: "a".repeat(64),
      zizmorBinaryPath: files.paths.zizmor,
      zizmorSha256: "b".repeat(64),
      runtimeLibraryPaths: [files.libraries],
      runCommand,
    });
    expect(domain.enforcedIsolation).toBe(false);
    await domain.guardAndExtract(files.archive, files.source);
    expect(domain.enforcedIsolation).toBe(true);
    const result = await domain.scan(files.source);
    expect(result).toMatchObject({
      applicability: { osv: false, zizmor: true, opengrep: false },
      engineResults: [{ engine: "gitleaks", normalized: { coverage: "complete" } }],
    });
    const sandboxCalls = calls.slice(1);
    expect(sandboxCalls).toHaveLength(3);
    for (const args of sandboxCalls) {
      expect(args).toContain("--unshare-all");
      expect(args).toContain("--unshare-user");
      expect(args).toContain("--disable-userns");
      expect(args).toContain("--clearenv");
      const remountIndex = args.lastIndexOf("--remount-ro");
      expect(args[remountIndex + 1]).toBe("/");
      expect(remountIndex).toBeGreaterThan(args.lastIndexOf("--bind"));
      expect(remountIndex).toBeGreaterThan(args.lastIndexOf("--ro-bind"));
      expect(remountIndex).toBeLessThan(args.lastIndexOf("--chdir"));
      expect(args).toContain("/tools/zizmor");
      expect(args).toContain("ZIZMOR_SHA256");
      expect(args.join(" ")).not.toContain("WORKER_SECRET");
      expect(args.join(" ")).not.toContain("GITHUB_TOKEN");
    }
  });

  it("rejects an archive-derived string smuggled into the result", async () => {
    const files = await fixture();
    await mkdir(files.source, { mode: 0o700 });
    const runCommand: ScannerCommandRunner = async (_executable, args) => {
      if (args[0] === "--version") {
        return { stdout: Buffer.from("bubblewrap 0.11.0\n"), stderr: Buffer.alloc(0) };
      }
      const value =
        args.at(-1) === "probe"
          ? {
              schemaVersion: 1,
              networkDenied: true,
              credentialPathsHidden: true,
              outsideWriteDenied: true,
              environmentClean: true,
            }
          : {
              schemaVersion: 1,
              applicability: { osv: true, zizmor: true, opengrep: true },
              engineResults: [],
              engineFailures: { gitleaks: "SCANNER_INTERNAL" },
              source: "RVN_SYNTHETIC_SECRET",
            };
      await writeFile(
        path.join(outputDirectory(args), "result.json"),
        JSON.stringify(value),
      );
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const domain = new BubblewrapRepositoryScanDomain({
      bubblewrapPath: files.paths.bwrap,
      nodePath: files.paths.node,
      applicationBundlePath: files.paths.bundle,
      gitleaksBinaryPath: files.paths.gitleaks,
      gitleaksConfigPath: files.paths.config,
      gitleaksIgnorePath: files.paths.ignore,
      gitleaksSha256: "a".repeat(64),
      runtimeLibraryPaths: [files.libraries],
      runCommand,
    });
    await expect(domain.scan(files.source)).rejects.toThrow("NORMALIZATION_REJECTED");
  });

  it("does not advertise isolation when an escape probe fails", async () => {
    const files = await fixture();
    const runCommand: ScannerCommandRunner = async (_executable, args) => {
      if (args[0] === "--version") {
        return { stdout: Buffer.from("bubblewrap 0.11.0\n"), stderr: Buffer.alloc(0) };
      }
      await writeFile(
        path.join(outputDirectory(args), "result.json"),
        JSON.stringify({
          schemaVersion: 1,
          networkDenied: false,
          credentialPathsHidden: true,
          outsideWriteDenied: true,
          environmentClean: true,
        }),
      );
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const domain = new BubblewrapRepositoryScanDomain({
      bubblewrapPath: files.paths.bwrap,
      nodePath: files.paths.node,
      applicationBundlePath: files.paths.bundle,
      gitleaksBinaryPath: files.paths.gitleaks,
      gitleaksConfigPath: files.paths.config,
      gitleaksIgnorePath: files.paths.ignore,
      gitleaksSha256: "a".repeat(64),
      runtimeLibraryPaths: [files.libraries],
      runCommand,
    });
    await expect(domain.verify()).rejects.toThrow();
    expect(domain.enforcedIsolation).toBe(false);
  });

  it("resolves trusted runtime symlinks before execution and mounting", async () => {
    const files = await fixture();
    const bwrapLink = path.join(files.root, "bwrap-link");
    const nodeLink = path.join(files.root, "node-link");
    await symlink(files.paths.bwrap, bwrapLink);
    await symlink(files.paths.node, nodeLink);
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const runCommand: ScannerCommandRunner = async (executable, args) => {
      calls.push({ executable, args: [...args] });
      if (args[0] === "--version") {
        return { stdout: Buffer.from("bubblewrap 0.11.0\n"), stderr: Buffer.alloc(0) };
      }
      await writeFile(
        path.join(outputDirectory(args), "result.json"),
        JSON.stringify({
          schemaVersion: 1,
          networkDenied: true,
          credentialPathsHidden: true,
          outsideWriteDenied: true,
          environmentClean: true,
        }),
      );
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const domain = new BubblewrapRepositoryScanDomain({
      bubblewrapPath: bwrapLink,
      nodePath: nodeLink,
      applicationBundlePath: files.paths.bundle,
      gitleaksBinaryPath: files.paths.gitleaks,
      gitleaksConfigPath: files.paths.config,
      gitleaksIgnorePath: files.paths.ignore,
      gitleaksSha256: "a".repeat(64),
      runtimeLibraryPaths: [files.libraries],
      runCommand,
    });

    await domain.verify();

    const canonicalBwrap = await realpath(files.paths.bwrap);
    const canonicalNode = await realpath(files.paths.node);
    expect(calls.every(({ executable }) => executable === canonicalBwrap)).toBe(true);
    expect(calls[1]?.args).toContain(canonicalNode);
    expect(calls[1]?.args).not.toContain(nodeLink);
  });
});
