import { spawn } from "node:child_process";
import { ScannerError, type ScannerErrorCode } from "./types.js";

const CLOSE_GRACE_MS = 1_000;

export interface ScannerCommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface ScannerCommandOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
}

export type ScannerCommandRunner = (
  executable: string,
  args: readonly string[],
  options: ScannerCommandOptions,
) => Promise<ScannerCommandResult>;

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/**
 * Runs one verified scanner command in its own POSIX process group. This is
 * defense in depth for bounded cleanup, not the public Linux cgroup boundary.
 */
export const runScannerCommand: ScannerCommandRunner = async (
  executable,
  args,
  options,
) => {
  if (process.platform === "win32") {
    throw new ScannerError("SCANNER_INTERNAL");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let outputLimited = false;
    let internalFailure = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timers: {
      runtime: NodeJS.Timeout | undefined;
      close: NodeJS.Timeout | undefined;
    } = { runtime: undefined, close: undefined };

    const clearTimers = (): void => {
      if (timers.runtime !== undefined) clearTimeout(timers.runtime);
      if (timers.close !== undefined) clearTimeout(timers.close);
    };
    const fail = (code: ScannerErrorCode): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new ScannerError(code));
    };
    const succeed = (result: ScannerCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const failureCode = (): ScannerErrorCode =>
      timedOut
        ? "SCANNER_TIMEOUT"
        : outputLimited
          ? "SCANNER_OUTPUT_LIMIT"
          : "SCANNER_INTERNAL";

    let child;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        detached: true,
        env: { LANG: "C", LC_ALL: "C" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      fail("SCANNER_INTERNAL");
      return;
    }
    const childPid = child.pid;

    const armCloseFallback = (): void => {
      if (timers.close !== undefined || settled) return;
      timers.close = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        fail(failureCode());
      }, CLOSE_GRACE_MS);
    };

    const killOwnedProcessGroup = (): void => {
      if (childPid === undefined) return;
      let groupSignalled = false;
      try {
        process.kill(-childPid, "SIGKILL");
        groupSignalled = true;
      } catch (error) {
        if (!isErrnoCode(error, "ESRCH")) internalFailure = true;
      }
      if (
        !groupSignalled &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          if (!child.kill("SIGKILL")) internalFailure = true;
        } catch {
          internalFailure = true;
        }
      }
    };

    const terminateAndBoundClose = (): void => {
      if (settled) return;
      killOwnedProcessGroup();
      armCloseFallback();
    };

    timers.runtime = setTimeout(() => {
      timedOut = true;
      terminateAndBoundClose();
    }, options.timeoutMs);

    child.stdout.on("data", (value: Buffer) => {
      if (outputLimited) return;
      stdoutBytes += value.length;
      if (stdoutBytes > options.stdoutLimitBytes) {
        outputLimited = true;
        terminateAndBoundClose();
      } else {
        stdout.push(value);
      }
    });
    child.stderr.on("data", (value: Buffer) => {
      if (outputLimited) return;
      stderrBytes += value.length;
      if (stderrBytes > options.stderrLimitBytes) {
        outputLimited = true;
        terminateAndBoundClose();
      } else {
        stderr.push(value);
      }
    });
    child.stdout.once("error", () => {
      internalFailure = true;
      terminateAndBoundClose();
    });
    child.stderr.once("error", () => {
      internalFailure = true;
      terminateAndBoundClose();
    });
    child.once("error", () => {
      internalFailure = true;
      terminateAndBoundClose();
    });
    child.once("exit", () => {
      terminateAndBoundClose();
    });
    child.once("close", (code) => {
      if (timedOut) {
        fail("SCANNER_TIMEOUT");
      } else if (outputLimited) {
        fail("SCANNER_OUTPUT_LIMIT");
      } else if (internalFailure || code !== 0) {
        fail("SCANNER_INTERNAL");
      } else {
        succeed({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      }
    });
  });
};
