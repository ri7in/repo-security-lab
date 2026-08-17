import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GitleaksScanner } from "@app/scanners";
import { runScannerCommand } from "../src/command-runner.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/process-tree.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];
const ownedPids = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

async function waitForDeath(pid: number): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isAlive(pid)).toBe(false);
  ownedPids.delete(pid);
}

async function markerExists(filename: string): Promise<boolean> {
  return await stat(filename).then(
    () => true,
    () => false,
  );
}

async function processFixture(): Promise<{
  root: string;
  marker: string;
  pidFile: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "scanner-command-runner-"));
  temporaryDirectories.push(root);
  return {
    root,
    marker: path.join(root, "descendant-marker"),
    pidFile: path.join(root, "descendant-pid"),
  };
}

async function readOwnedPid(filename: string): Promise<number> {
  const pid = Number(await readFile(filename, "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  ownedPids.add(pid);
  return pid;
}

async function assertDescendantRemoved(
  pidFile: string,
  marker: string,
): Promise<void> {
  const pid = await readOwnedPid(pidFile);
  await waitForDeath(pid);
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(await markerExists(marker)).toBe(false);
}

afterEach(async () => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The owned synthetic process may already have been reaped.
    }
  }
  ownedPids.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("bounded scanner command runner", () => {
  async function runMode(
    mode: string,
    overrides: Partial<{
      timeoutMs: number;
      stdoutLimitBytes: number;
      stderrLimitBytes: number;
      acceptedExitCodes: readonly number[];
    }> = {},
  ): Promise<{
    result: ReturnType<typeof runScannerCommand>;
    marker: string;
    pidFile: string;
  }> {
    const setup = await processFixture();
    return {
      result: runScannerCommand(
        process.execPath,
        [fixturePath, mode, setup.marker, setup.pidFile],
        {
          cwd: setup.root,
          timeoutMs: overrides.timeoutMs ?? 2_000,
          stdoutLimitBytes: overrides.stdoutLimitBytes ?? 1_024,
          stderrLimitBytes: overrides.stderrLimitBytes ?? 1_024,
          ...(overrides.acceptedExitCodes === undefined
            ? {}
            : { acceptedExitCodes: overrides.acceptedExitCodes }),
        },
      ),
      marker: setup.marker,
      pidFile: setup.pidFile,
    };
  }

  it("captures bounded stdout and stderr on success", async () => {
    const setup = await runMode("success");
    await expect(setup.result).resolves.toEqual({
      stdout: Buffer.from("bounded stdout"),
      stderr: Buffer.from("bounded stderr"),
      exitCode: 0,
    });
  });

  it("kills a lingering descendant when its leader exits successfully", async () => {
    const setup = await runMode("lingering");
    await expect(setup.result).resolves.toMatchObject({
      stdout: Buffer.from("leader output"),
    });
    await assertDescendantRemoved(setup.pidFile, setup.marker);
  });

  it("fails within the close grace when a new-session process retains its pipes", async () => {
    const started = Date.now();
    const setup = await runMode("escaped", { timeoutMs: 5_000 });
    await expect(setup.result).rejects.toMatchObject({
      code: "SCANNER_INTERNAL",
      message: "SCANNER_INTERNAL",
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    const pid = await readOwnedPid(setup.pidFile);
    expect(isAlive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
    await waitForDeath(pid);
  });

  it("settles a timeout after killing the complete owned process group", async () => {
    const setup = await runMode("waiting", { timeoutMs: 250 });
    await expect(setup.result).rejects.toMatchObject({
      code: "SCANNER_TIMEOUT",
      message: "SCANNER_TIMEOUT",
    });
    await assertDescendantRemoved(setup.pidFile, setup.marker);
  });

  for (const [mode, limit] of [
    ["stdout-overflow", "stdoutLimitBytes"],
    ["stderr-overflow", "stderrLimitBytes"],
  ] as const) {
    it(`kills the process group on ${mode}`, async () => {
      const setup = await runMode(mode, { [limit]: 1_024 });
      await expect(setup.result).rejects.toMatchObject({
        code: "SCANNER_OUTPUT_LIMIT",
        message: "SCANNER_OUTPUT_LIMIT",
      });
      await assertDescendantRemoved(setup.pidFile, setup.marker);
    });
  }

  it("maps a nonzero exit to one fixed failure", async () => {
    const setup = await runMode("nonzero");
    await expect(setup.result).rejects.toMatchObject({
      code: "SCANNER_EXIT_FAILURE",
      message: "SCANNER_EXIT_FAILURE",
      exitCode: 7,
      diagnosticHint: "OTHER",
    });
  });

  it("returns a declared nonzero exit without weakening the default", async () => {
    const setup = await runMode("nonzero", { acceptedExitCodes: [0, 7] });
    await expect(setup.result).resolves.toEqual({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 7,
    });
  });

  it("rejects an empty, duplicate, or out-of-range exit allowlist", async () => {
    const setup = await processFixture();
    for (const acceptedExitCodes of [[], [0, 0], [-1], [256]]) {
      await expect(
        runScannerCommand(process.execPath, [fixturePath, "success"], {
          cwd: setup.root,
          timeoutMs: 1_000,
          stdoutLimitBytes: 1_024,
          stderrLimitBytes: 1_024,
          acceptedExitCodes,
        }),
      ).rejects.toMatchObject({ code: "SCANNER_INTERNAL" });
    }
  });

  it("maps a spawn failure to one fixed failure without echoing its path", async () => {
    const setup = await processFixture();
    const canary = path.join(setup.root, "RVN_DO_NOT_ECHO");
    const result = runScannerCommand(canary, [], {
      cwd: setup.root,
      timeoutMs: 100,
      stdoutLimitBytes: 1_024,
      stderrLimitBytes: 1_024,
    });
    await expect(result).rejects.toMatchObject({
      code: "SCANNER_INTERNAL",
      message: "SCANNER_INTERNAL",
    });
    await expect(result).rejects.not.toThrow(canary);
  });

  it("settles exactly once when exit races the timeout", async () => {
    const setup = await runMode("race", { timeoutMs: 50 });
    let settlements = 0;
    await setup.result.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settlements).toBe(1);
  });

  it("keeps the scanner adapter bounded after a valid leader result", async () => {
    const setup = await processFixture();
    const source = path.join(setup.root, "source");
    const binary = path.join(setup.root, "synthetic-gitleaks");
    await mkdir(source);
    const program = `#!${process.execPath}\n${String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync, writeSync } = require("node:fs");
if (process.argv[2] === "version") {
  writeSync(1, "8.30.1\n");
} else {
  const child = spawn(process.execPath, [${JSON.stringify(fixturePath)}, "grandchild", ${JSON.stringify(setup.marker)}, ${JSON.stringify(setup.pidFile)}], { stdio: "inherit" });
  writeFileSync(${JSON.stringify(setup.pidFile)}, String(child.pid));
  writeSync(1, "[]");
  process.exit(0);
}
`}`;
    await writeFile(binary, program, { mode: 0o700 });
    await chmod(binary, 0o700);
    const binaryHash = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");

    await expect(
      new GitleaksScanner({
        binaryPath: binary,
        expectedBinarySha256: binaryHash,
      }).scan(source),
    ).resolves.toEqual({
      findings: [],
      rawFindingCount: 0,
      findingLimitExceeded: false,
    });
    await assertDescendantRemoved(setup.pidFile, setup.marker);
  });
});
