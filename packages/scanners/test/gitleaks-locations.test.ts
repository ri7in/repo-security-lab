/* eslint-disable @typescript-eslint/require-await -- command doubles model asynchronous child processes */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitleaksScanner, type ScannerCommandRunner } from "@app/scanners";
import { MAX_LOCATIONS, findingLocationSchema } from "@app/contracts";

/**
 * The published location channel.
 *
 * These lock the boundary that replaced source-blind reporting. A location may
 * say WHERE a finding is. It may never carry what the file contains, and it
 * may never point outside the extracted tree.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  binary: string;
  source: string;
  binaryHash: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-loc-"));
  temporaryDirectories.push(root);
  const binary = path.join(root, "gitleaks");
  const source = path.join(root, "source");
  await writeFile(binary, "synthetic test executable\n", { mode: 0o700 });
  await chmod(binary, 0o700);
  await mkdir(source);
  return {
    binary,
    source,
    binaryHash: createHash("sha256")
      .update("synthetic test executable\n")
      .digest("hex"),
  };
}

function runnerReturning(findings: unknown[]): ScannerCommandRunner {
  return async (_executable, args) =>
    args[0] === "version"
      ? { stdout: Buffer.from("8.30.1\n"), stderr: Buffer.alloc(0) }
      : {
          stdout: Buffer.from(JSON.stringify(findings)),
          stderr: Buffer.alloc(0),
        };
}

function raw(overrides: Record<string, unknown> = {}): unknown {
  return {
    RuleID: "generic-api-key",
    Secret: "REDACTED",
    Match: "KEY=REDACTED",
    File: "src/config.ts",
    StartLine: 12,
    ...overrides,
  };
}

async function scanWith(findings: unknown[]): Promise<
  Awaited<ReturnType<GitleaksScanner["scan"]>>
> {
  const setup = await fixture();
  return await new GitleaksScanner({
    binaryPath: setup.binary,
    expectedBinarySha256: setup.binaryHash,
    runCommand: runnerReturning(findings),
  }).scan(setup.source);
}

/** Scans with findings built from the real scratch path the scanner is given. */
async function scanWithAbsolute(
  build: (source: string) => unknown[],
): Promise<{
  result: Awaited<ReturnType<GitleaksScanner["scan"]>>;
  source: string;
}> {
  const setup = await fixture();
  // The scanner resolves the scan root with realpath before handing it to
  // gitleaks, and gitleaks echoes that resolved root back. On macOS /var is a
  // symlink to /private/var, so a test that skips this compares two different
  // spellings of the same directory and proves nothing.
  const resolved = await realpath(setup.source);
  const result = await new GitleaksScanner({
    binaryPath: setup.binary,
    expectedBinarySha256: setup.binaryHash,
    runCommand: runnerReturning(build(resolved)),
  }).scan(setup.source);
  return { result, source: resolved };
}

describe("published finding locations", () => {
  it("reports where a finding sits", async () => {
    const result = await scanWith([raw()]);
    expect(result.locations).toEqual([
      {
        engine: "gitleaks",
        ruleId: "generic-api-key",
        path: "src/config.ts",
        startLine: 12,
      },
    ]);
    expect(findingLocationSchema.safeParse(result.locations[0]).success).toBe(
      true,
    );
  });

  it("carries no secret value and no file contents", async () => {
    const result = await scanWith([
      raw({ Match: "KEY=REDACTED plus target-controlled context" }),
    ]);
    const serialized = JSON.stringify(result.locations);
    expect(serialized).not.toContain("target-controlled");
    expect(serialized).not.toMatch(/AKIA|sk_live|ghp_/);
  });

  it("still reports a finding that cannot be located", async () => {
    const result = await scanWith([raw({ StartLine: undefined })]);
    expect(result.findings).toEqual([{ ruleId: "generic-api-key" }]);
    expect(result.locations).toEqual([]);
  });

  it("refuses a path that escapes the extracted tree", async () => {
    const result = await scanWith([raw({ File: "../../../../etc/passwd" })]);
    expect(result.locations).toEqual([]);
    expect(result.findings).toHaveLength(1);
  });

  it("refuses a path carrying invisible characters", async () => {
    // Written as an escape on purpose. The literal character is invisible in
    // an editor and in a diff, which is exactly why a path may not carry one:
    // it could make a published location read as a different file entirely.
    const result = await scanWith([raw({ File: "src/a\u200Bb.ts" })]);
    expect(result.locations).toEqual([]);
  });

  it("allows an ordinary space, which is a legal filename character", async () => {
    const result = await scanWith([raw({ File: "src/my config.ts" })]);
    expect(result.locations[0]?.path).toBe("src/my config.ts");
  });

  it("publishes a repository-relative path, never the scratch directory", async () => {
    const { result, source } = await scanWithAbsolute((root) => [
      raw({ File: path.join(root, "src", "config.ts") }),
    ]);
    // Gitleaks echoes back whatever root it was handed. Publishing that
    // verbatim would put the worker's scratch layout into a public report.
    expect(result.locations[0]?.path).toBe("src/config.ts");
    expect(JSON.stringify(result.locations)).not.toContain(source);
    expect(JSON.stringify(result.locations)).not.toContain("/var/");
    expect(JSON.stringify(result.locations)).not.toContain(tmpdir());
  });

  it("drops an absolute path that resolves outside the scan root", async () => {
    const { result } = await scanWithAbsolute(() => [
      raw({ File: "/etc/passwd" }),
    ]);
    expect(result.locations).toEqual([]);
    expect(result.findings).toHaveLength(1);
  });

  it("strips the archive wrapper so a path is repository-relative", async () => {
    // A GitHub tarball unpacks into one folder named owner-repo-shortsha.
    // Publishing "ri7in-salun-723983a/QUICKSTART.md" names no file that
    // exists in the repository and cannot be opened or linked to.
    const setup = await fixture();
    const wrapper = "ri7in-salun-723983a";
    await mkdir(path.join(setup.source, wrapper), { recursive: true });
    const result = await new GitleaksScanner({
      binaryPath: setup.binary,
      expectedBinarySha256: setup.binaryHash,
      runCommand: runnerReturning([
        raw({ File: `${wrapper}/QUICKSTART.md`, StartLine: 58 }),
      ]),
    }).scan(setup.source);
    expect(result.locations[0]?.path).toBe("QUICKSTART.md");
  });

  it("leaves paths alone when the tree has no single wrapper", async () => {
    const setup = await fixture();
    await mkdir(path.join(setup.source, "alpha"), { recursive: true });
    await mkdir(path.join(setup.source, "beta"), { recursive: true });
    const result = await new GitleaksScanner({
      binaryPath: setup.binary,
      expectedBinarySha256: setup.binaryHash,
      runCommand: runnerReturning([raw({ File: "alpha/config.ts" })]),
    }).scan(setup.source);
    expect(result.locations[0]?.path).toBe("alpha/config.ts");
  });

  it("stays bounded however many findings the target produces", async () => {
    const many = Array.from({ length: MAX_LOCATIONS * 5 }, (_, index) =>
      raw({ StartLine: index + 1 }),
    );
    const result = await scanWith(many);
    expect(result.locations).toHaveLength(MAX_LOCATIONS);
    // Bounding the channel must never bound the ledger: every finding is still
    // counted, only the published locations are capped.
    expect(result.findings).toHaveLength(MAX_LOCATIONS * 5);
  });
});
