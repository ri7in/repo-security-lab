import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, expect, test } from "vitest";
import { BubblewrapRepositoryScanDomain } from "../src/bubblewrap-domain.js";

const enabled = process.env["RUN_BWRAP_E2E"] === "1";
const bubblewrapPath = process.env["BUBBLEWRAP_BINARY"];
const bundlePath = process.env["SCAN_DOMAIN_BUNDLE"];
const gitleaksPath = process.env["GITLEAKS_BINARY"];
const gitleaksHash = process.env["GITLEAKS_SHA256"];
const zizmorPath = process.env["ZIZMOR_BINARY"];
const zizmorHash = process.env["ZIZMOR_SHA256"];
const nodePath = process.env["SCAN_NODE_BINARY"] ?? process.execPath;
const runtimeLibraryPaths = (process.env["SCAN_RUNTIME_LIBRARY_PATHS"] ?? "")
  .split(",")
  .filter((entry) => entry !== "");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(0o600, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(data.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(
    header,
    148,
  );
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

test.skipIf(
  !enabled ||
    bubblewrapPath === undefined ||
    bundlePath === undefined ||
    gitleaksPath === undefined ||
    gitleaksHash === undefined ||
    zizmorPath === undefined ||
    zizmorHash === undefined ||
    runtimeLibraryPaths.length === 0,
)(
  "proves extraction and scanning inside a credential-free no-network namespace",
  async () => {
    if (
      bubblewrapPath === undefined ||
      bundlePath === undefined ||
      gitleaksPath === undefined ||
      gitleaksHash === undefined ||
      zizmorPath === undefined ||
      zizmorHash === undefined
    ) {
      throw new Error("bubblewrap proof prerequisites missing");
    }
    const jobRoot = await mkdtemp(path.join(tmpdir(), "repo-security-bwrap-live-"));
    temporaryDirectories.push(jobRoot);
    const syntheticSecret = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const archive = Buffer.concat([
      tarEntry("fixture/", Buffer.alloc(0), "5"),
      tarEntry("fixture/credential.txt", Buffer.from(syntheticSecret)),
      tarEntry("fixture/.github/", Buffer.alloc(0), "5"),
      tarEntry("fixture/.github/workflows/", Buffer.alloc(0), "5"),
      tarEntry(
        "fixture/.github/workflows/ci.yml",
        Buffer.from("name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n"),
      ),
      Buffer.alloc(1_024),
    ]);
    const archivePath = path.join(jobRoot, "inbound.tar.gz");
    const sourcePath = path.join(jobRoot, "source");
    await writeFile(archivePath, gzipSync(archive), { mode: 0o600 });

    const domain = new BubblewrapRepositoryScanDomain({
      bubblewrapPath,
      nodePath,
      applicationBundlePath: bundlePath,
      gitleaksBinaryPath: gitleaksPath,
      gitleaksConfigPath: path.resolve("packages/scanners/config/gitleaks.toml"),
      gitleaksIgnorePath: path.resolve("packages/scanners/config/gitleaks.ignore"),
      gitleaksSha256: gitleaksHash,
      zizmorBinaryPath: zizmorPath,
      zizmorSha256: zizmorHash,
      runtimeLibraryPaths,
    });
    await domain.verify();
    expect(domain.enforcedIsolation).toBe(true);
    await domain.guardAndExtract(archivePath, sourcePath);
    const result = await domain.scan(sourcePath);
    const serialized = JSON.stringify(result);
    expect(result.engineFailures).toEqual({});
    expect(result.engineResults.map(({ engine }) => engine).sort()).toEqual([
      "gitleaks",
      "zizmor",
    ]);
    expect(serialized).not.toContain(syntheticSecret);
  },
  45_000,
);
