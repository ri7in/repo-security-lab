import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  GITLEAKS_CONFIG_SHA256,
  GITLEAKS_IGNORE_SHA256,
  gitleaksRuleToken,
} from "./manifest.js";
import {
  ScannerError,
  type GitleaksScanResult,
} from "./types.js";

const GITLEAKS_VERSION = "8.30.1";
const MAX_STDOUT_BYTES = 32 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 4 * 1_024 * 1_024;
const MAX_FINDINGS = 10_000;
const CONFIG_PATH = fileURLToPath(
  new URL("../config/gitleaks.toml", import.meta.url),
);
const IGNORE_PATH = fileURLToPath(
  new URL("../config/gitleaks.ignore", import.meta.url),
);
const outputDecoder = new TextDecoder("utf-8", { fatal: true });

const findingSchema = z.object({
  RuleID: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  Secret: z.literal("REDACTED"),
  // Gitleaks replaces the secret span, not necessarily the entire matching
  // expression (for example `TOKEN=REDACTED`). This field is validated only
  // to prove redaction happened and is then discarded inside the hostile
  // scanner domain; it never enters the normalized packet or return value.
  Match: z.string().min(8).max(8_192).refine((value) => value.includes("REDACTED")),
});

interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type ScannerCommandRunner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly stdoutLimitBytes: number;
    readonly stderrLimitBytes: number;
  },
) => Promise<CommandResult>;

export interface GitleaksScannerOptions {
  readonly binaryPath: string;
  readonly expectedBinarySha256: string;
  readonly trustedConfigPath?: string;
  readonly trustedIgnorePath?: string;
  readonly timeoutMs?: number;
  readonly runCommand?: ScannerCommandRunner;
}

async function sha256(filename: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filename);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

const defaultCommandRunner: ScannerCommandRunner = async (
  executable,
  args,
  options,
) =>
  await new Promise((resolve, reject) => {
    let timedOut = false;
    let outputLimited = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { LANG: "C", LC_ALL: "C" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (value: Buffer) => {
      stdoutBytes += value.length;
      if (stdoutBytes > options.stdoutLimitBytes) {
        outputLimited = true;
        child.kill("SIGKILL");
      } else {
        stdout.push(value);
      }
    });
    child.stderr.on("data", (value: Buffer) => {
      stderrBytes += value.length;
      if (stderrBytes > options.stderrLimitBytes) {
        outputLimited = true;
        child.kill("SIGKILL");
      } else {
        stderr.push(value);
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new ScannerError("SCANNER_INTERNAL"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ScannerError("SCANNER_TIMEOUT"));
      } else if (outputLimited) {
        reject(new ScannerError("SCANNER_OUTPUT_LIMIT"));
      } else if (code !== 0) {
        reject(new ScannerError("SCANNER_INTERNAL"));
      } else {
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      }
    });
  });

async function assertTrustedFile(
  filename: string,
  expectedHash: string,
  executable: boolean,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new ScannerError("SCANNER_BINARY_MISMATCH");
  }
  const metadata = await lstat(filename).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    (executable && (metadata.mode & 0o111) === 0)
  ) {
    throw new ScannerError("SCANNER_BINARY_MISMATCH");
  }
  const resolved = await realpath(filename).catch(() => null);
  if (resolved === null || (await sha256(resolved)) !== expectedHash) {
    throw new ScannerError("SCANNER_BINARY_MISMATCH");
  }
  return resolved;
}

export class GitleaksScanner {
  readonly #binaryPath: string;
  readonly #expectedBinarySha256: string;
  readonly #configPath: string;
  readonly #ignorePath: string;
  readonly #timeoutMs: number;
  readonly #runCommand: ScannerCommandRunner;

  constructor(options: GitleaksScannerOptions) {
    this.#binaryPath = options.binaryPath;
    this.#expectedBinarySha256 = options.expectedBinarySha256;
    this.#configPath = options.trustedConfigPath ?? CONFIG_PATH;
    this.#ignorePath = options.trustedIgnorePath ?? IGNORE_PATH;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > 300_000
    ) {
      throw new Error("invalid Gitleaks timeout");
    }
    this.#runCommand = options.runCommand ?? defaultCommandRunner;
  }

  async verify(): Promise<void> {
    const binary = await assertTrustedFile(
      this.#binaryPath,
      this.#expectedBinarySha256,
      true,
    );
    await assertTrustedFile(this.#configPath, GITLEAKS_CONFIG_SHA256, false);
    await assertTrustedFile(this.#ignorePath, GITLEAKS_IGNORE_SHA256, false);
    const version = await this.#runCommand(binary, ["version"], {
      cwd: "/",
      timeoutMs: 5_000,
      stdoutLimitBytes: 1_024,
      stderrLimitBytes: 1_024,
    });
    if (version.stdout.toString("utf8").trim() !== GITLEAKS_VERSION) {
      throw new ScannerError("SCANNER_BINARY_MISMATCH");
    }
  }

  async scan(sourceDirectory: string): Promise<GitleaksScanResult> {
    await this.verify();
    const source = await realpath(sourceDirectory).catch(() => null);
    const sourceMetadata = source === null ? null : await stat(source).catch(() => null);
    if (source === null || sourceMetadata === null || !sourceMetadata.isDirectory()) {
      throw new ScannerError("SCANNER_INTERNAL");
    }
    const result = await this.#runCommand(
      await realpath(this.#binaryPath),
      [
        "dir",
        "--config",
        await realpath(this.#configPath),
        "--gitleaks-ignore-path",
        await realpath(this.#ignorePath),
        "--ignore-gitleaks-allow",
        "--max-archive-depth",
        "0",
        "--max-decode-depth",
        "2",
        "--max-target-megabytes",
        "20",
        "--timeout",
        "300",
        "--exit-code",
        "0",
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--redact=100",
        "--log-level",
        "error",
        "--no-banner",
        "--no-color",
        source,
      ],
      {
        cwd: "/",
        timeoutMs: this.#timeoutMs,
        stdoutLimitBytes: MAX_STDOUT_BYTES,
        stderrLimitBytes: MAX_STDERR_BYTES,
      },
    );

    let document: unknown;
    try {
      document = JSON.parse(outputDecoder.decode(result.stdout)) as unknown;
    } catch {
      throw new ScannerError("SCANNER_INVALID_OUTPUT");
    }
    if (!Array.isArray(document)) {
      throw new ScannerError("SCANNER_INVALID_OUTPUT");
    }
    const findings = document.map((value) => {
      const parsed = findingSchema.safeParse(value);
      if (!parsed.success || gitleaksRuleToken(parsed.data.RuleID) === null) {
        throw new ScannerError("SCANNER_INVALID_OUTPUT");
      }
      return { ruleId: parsed.data.RuleID };
    });
    return {
      findings: findings.slice(0, MAX_FINDINGS),
      rawFindingCount: findings.length,
      findingLimitExceeded: findings.length > MAX_FINDINGS,
    };
  }
}
