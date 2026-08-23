/* eslint-disable @typescript-eslint/require-await -- command doubles model asynchronous child processes */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITLEAKS_CONFIG_SHA256,
  GITLEAKS_IGNORE_SHA256,
  GITLEAKS_RULE_IDS,
  GitleaksScanner,
  failClosedScannerStub,
  gitleaksRuleToken,
  type ScannerCommandRunner,
} from "@app/scanners";

const temporaryDirectories: string[] = [];
const CONFIG_PATH = fileURLToPath(
  new URL("../config/gitleaks.toml", import.meta.url),
);
const IGNORE_PATH = fileURLToPath(
  new URL("../config/gitleaks.ignore", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<{
  binary: string;
  source: string;
  binaryHash: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-scanner-"));
  temporaryDirectories.push(root);
  const binary = path.join(root, "gitleaks");
  const source = path.join(root, "source");
  await writeFile(binary, "synthetic test executable\n", { mode: 0o700 });
  await chmod(binary, 0o700);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
  return {
    binary,
    source,
    binaryHash: createHash("sha256")
      .update("synthetic test executable\n")
      .digest("hex"),
  };
}

function finding(overrides: Record<string, unknown> = {}): unknown {
  return {
    RuleID: "github-pat",
    Secret: "REDACTED",
    Match: "REDACTED",
    File: "target-controlled/path",
    ...overrides,
  };
}

describe("pinned Gitleaks adapter", () => {
  it("pins every default rule id to a unique stable numeric token", async () => {
    expect(GITLEAKS_RULE_IDS).toHaveLength(222);
    expect(new Set(GITLEAKS_RULE_IDS)).toHaveLength(222);
    expect(gitleaksRuleToken(GITLEAKS_RULE_IDS[0] ?? "")).toBe(1);
    expect(gitleaksRuleToken(GITLEAKS_RULE_IDS.at(-1) ?? "")).toBe(222);
    expect(gitleaksRuleToken("target-invented-rule")).toBeNull();
    expect(
      createHash("sha256").update(await readFile(CONFIG_PATH)).digest("hex"),
    ).toBe(GITLEAKS_CONFIG_SHA256);
    expect(
      createHash("sha256").update(await readFile(IGNORE_PATH)).digest("hex"),
    ).toBe(GITLEAKS_IGNORE_SHA256);
  });

  it("uses only explicit trusted policy and returns no secret or scanner-prose strings", async () => {
    const setup = await fixture();
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runCommand: ScannerCommandRunner = async (_executable, args) => {
      mutableCalls.push([...args]);
      return args[0] === "version"
        ? { stdout: Buffer.from("8.30.1\n"), stderr: Buffer.alloc(0) }
        : {
            stdout: Buffer.from(
              JSON.stringify([
                finding({ Match: "TOKEN=REDACTED target-controlled-context" }),
              ]),
            ),
            stderr: Buffer.from("target-controlled stderr is discarded"),
          };
    };
    const result = await new GitleaksScanner({
      binaryPath: setup.binary,
      expectedBinarySha256: setup.binaryHash,
      runCommand,
    }).scan(setup.source);

    expect(result).toEqual({
      findings: [{ ruleId: "github-pat" }],
      rawFindingCount: 1,
      findingLimitExceeded: false,
      // No StartLine on this fixture, so there is nothing locatable. A finding
      // without a line is still reported, just without a location.
      locations: [],
    });
    const scanArgs = calls[1] ?? [];
    expect(scanArgs).toContain("--config");
    expect(scanArgs).toContain("--gitleaks-ignore-path");
    expect(scanArgs).toContain("--ignore-gitleaks-allow");
    expect(scanArgs).toContain("--redact=100");
    expect(JSON.stringify(result)).not.toContain("target-controlled");
  });

  it("fails closed on non-redacted or unknown-rule output without echoing it", async () => {
    const setup = await fixture();
    for (const rawFinding of [
      finding({ Secret: "RVN_DO_NOT_ECHO" }),
      finding({ RuleID: "target-invented-rule" }),
    ]) {
      const runCommand: ScannerCommandRunner = async (_executable, args) =>
        args[0] === "version"
          ? { stdout: Buffer.from("8.30.1\n"), stderr: Buffer.alloc(0) }
          : {
              stdout: Buffer.from(JSON.stringify([rawFinding])),
              stderr: Buffer.alloc(0),
            };
      const promise = new GitleaksScanner({
        binaryPath: setup.binary,
        expectedBinarySha256: setup.binaryHash,
        runCommand,
      }).scan(setup.source);
      await expect(promise).rejects.toMatchObject({
        code: "SCANNER_INVALID_OUTPUT",
        message: "SCANNER_INVALID_OUTPUT",
      });
    }
  });

  it("marks the finding ceiling explicitly instead of silently claiming completion", async () => {
    const setup = await fixture();
    const rawFindings = Array.from({ length: 10_001 }, () => finding());
    const runCommand: ScannerCommandRunner = async (_executable, args) =>
      args[0] === "version"
        ? { stdout: Buffer.from("8.30.1\n"), stderr: Buffer.alloc(0) }
        : {
            stdout: Buffer.from(JSON.stringify(rawFindings)),
            stderr: Buffer.alloc(0),
          };
    const result = await new GitleaksScanner({
      binaryPath: setup.binary,
      expectedBinarySha256: setup.binaryHash,
      runCommand,
    }).scan(setup.source);
    expect(result.findings).toHaveLength(10_000);
    expect(result.rawFindingCount).toBe(10_001);
    expect(result.findingLimitExceeded).toBe(true);
  });

  it("refuses a binary hash mismatch before any process starts", async () => {
    const setup = await fixture();
    let called = false;
    const runCommand: ScannerCommandRunner = async () => {
      called = true;
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    await expect(
      new GitleaksScanner({
        binaryPath: setup.binary,
        expectedBinarySha256: "0".repeat(64),
        runCommand,
      }).verify(),
    ).rejects.toMatchObject({ code: "SCANNER_BINARY_MISMATCH" });
    expect(called).toBe(false);
  });

  it("keeps not-yet-integrated engines explicitly fail-closed", async () => {
    for (const engine of ["osv", "zizmor", "opengrep"] as const) {
      await expect(failClosedScannerStub(engine).scan()).rejects.toMatchObject({
        code: "SCANNER_INTERNAL",
      });
    }
  });
});
