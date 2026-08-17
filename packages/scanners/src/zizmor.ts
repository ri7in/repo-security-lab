import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ZIZMOR_CONFIDENCES,
  ZIZMOR_SEVERITIES,
  type ZizmorScanResult,
  ScannerError,
} from "./types.js";
import {
  ZIZMOR_VERSION,
  zizmorVariantToken,
} from "./zizmor-manifest.js";
import {
  runScannerCommand,
  type ScannerCommandRunner,
} from "./command-runner.js";

export const ZIZMOR_INPUT_LIMITS = Object.freeze({
  files: 128,
  fileBytes: 1 * 1_024 * 1_024,
  aggregateBytes: 4 * 1_024 * 1_024,
  findings: 1_000,
});

const MAX_STDOUT_BYTES = 4 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 256 * 1_024;
// The supported scan runtime is Linux and mounts a private, disposable /tmp.
const STAGING_DIRECTORY = "/tmp";
const outputDecoder = new TextDecoder("utf-8", { fatal: true });

const findingSchema = z.strictObject({
  ident: z.string().min(1).max(128).regex(/^[a-z][a-z0-9-]*$/),
  desc: z.string().max(1_024),
  url: z.string().max(2_048),
  determinations: z.strictObject({
    confidence: z.enum(ZIZMOR_CONFIDENCES),
    severity: z.enum(ZIZMOR_SEVERITIES),
    persona: z.literal("Regular"),
  }),
  locations: z.array(z.unknown()).max(1_024),
  ignored: z.boolean(),
  fixes: z.array(z.unknown()).max(1_024),
});

// Stdout is already hard-bounded to 4 MiB by the process runner. Parse every
// entry inside that byte ceiling so a >1,000 result is conservatively partial
// rather than target-order truncated.
const outputSchema = z.array(findingSchema);

const EXIT_SEVERITY = new Map<number, (typeof ZIZMOR_SEVERITIES)[number]>([
  [11, "Informational"],
  [12, "Low"],
  [13, "Medium"],
  [14, "High"],
]);

const SEVERITY_RANK = new Map(
  ZIZMOR_SEVERITIES.map((severity, index) => [severity, index]),
);

interface WorkflowInput {
  readonly bytes: Uint8Array;
  readonly extension: ".yml" | ".yaml";
}

export interface ZizmorScannerOptions {
  readonly binaryPath: string;
  readonly expectedBinarySha256: string;
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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function workflowRoots(source: string): Promise<readonly string[]> {
  const roots = [source];
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== ".github") {
      roots.push(path.join(source, entry.name));
    }
  }
  return roots;
}

async function collectWorkflowInputs(source: string): Promise<readonly WorkflowInput[]> {
  const inputs: WorkflowInput[] = [];
  let aggregateBytes = 0;
  for (const root of await workflowRoots(source)) {
    const directory = path.join(root, ".github", "workflows");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw new ScannerError("SCANNER_INPUT_FAILURE");
    }
    for (const entry of entries) {
      const extension = entry.name.endsWith(".yaml")
        ? ".yaml"
        : entry.name.endsWith(".yml")
          ? ".yml"
          : null;
      if (extension === null) continue;
      if (!entry.isFile()) throw new ScannerError("SCANNER_INPUT_FAILURE");
      if (inputs.length >= ZIZMOR_INPUT_LIMITS.files) {
        throw new ScannerError("SCANNER_MEMORY_LIMIT");
      }
      const filename = path.join(directory, entry.name);
      const metadata = await lstat(filename).catch(() => null);
      if (
        metadata === null ||
        !metadata.isFile() ||
        metadata.isSymbolicLink()
      ) {
        throw new ScannerError("SCANNER_INPUT_FAILURE");
      }
      if (metadata.size > ZIZMOR_INPUT_LIMITS.fileBytes) {
        throw new ScannerError("SCANNER_MEMORY_LIMIT");
      }
      aggregateBytes += metadata.size;
      if (aggregateBytes > ZIZMOR_INPUT_LIMITS.aggregateBytes) {
        throw new ScannerError("SCANNER_MEMORY_LIMIT");
      }
      const bytes = await readFile(filename);
      if (bytes.byteLength !== metadata.size) {
        throw new ScannerError("SCANNER_INPUT_FAILURE");
      }
      inputs.push({ bytes, extension });
    }
  }
  return inputs;
}

async function stageWorkflowInputs(
  inputs: readonly WorkflowInput[],
): Promise<string> {
  const staging = await mkdtemp(
    path.join(STAGING_DIRECTORY, "repo-security-zizmor-input-"),
  );
  try {
    await chmod(staging, 0o700);
    const workflows = path.join(staging, ".github", "workflows");
    await mkdir(workflows, { recursive: true, mode: 0o700 });
    for (const [index, input] of inputs.entries()) {
      await writeFile(
        path.join(
          workflows,
          `workflow-${String(index).padStart(3, "0")}${input.extension}`,
        ),
        input.bytes,
        { flag: "wx", mode: 0o600 },
      );
    }
    return staging;
  } catch {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw new ScannerError("SCANNER_STAGE_FAILURE");
  }
}

export class ZizmorScanner {
  readonly #binaryPath: string;
  readonly #expectedBinarySha256: string;
  readonly #timeoutMs: number;
  readonly #runCommand: ScannerCommandRunner;

  constructor(options: ZizmorScannerOptions) {
    this.#binaryPath = options.binaryPath;
    this.#expectedBinarySha256 = options.expectedBinarySha256;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > 60_000
    ) {
      throw new Error("invalid zizmor timeout");
    }
    this.#runCommand = options.runCommand ?? runScannerCommand;
  }

  async #verifiedBinary(): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(this.#expectedBinarySha256)) {
      throw new ScannerError("SCANNER_BINARY_MISMATCH");
    }
    const metadata = await lstat(this.#binaryPath).catch(() => null);
    if (
      metadata === null ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o111) === 0
    ) {
      throw new ScannerError("SCANNER_BINARY_MISMATCH");
    }
    const binary = await realpath(this.#binaryPath).catch(() => null);
    if (binary === null || (await sha256(binary)) !== this.#expectedBinarySha256) {
      throw new ScannerError("SCANNER_BINARY_MISMATCH");
    }
    const version = await this.#runCommand(binary, ["--version"], {
      cwd: "/",
      timeoutMs: 5_000,
      stdoutLimitBytes: 1_024,
      stderrLimitBytes: 1_024,
      acceptedExitCodes: [0],
    });
    if (version.exitCode !== undefined && version.exitCode !== 0) {
      throw new ScannerError("SCANNER_BINARY_MISMATCH");
    }
    if (version.stdout.toString("utf8").trim() !== `zizmor ${ZIZMOR_VERSION}`) {
      throw new ScannerError("SCANNER_BINARY_MISMATCH");
    }
    return binary;
  }

  async verify(): Promise<void> {
    await this.#verifiedBinary();
  }

  async scan(sourceDirectory: string): Promise<ZizmorScanResult> {
    const binary = await this.#verifiedBinary();
    const source = await realpath(sourceDirectory).catch(() => null);
    const sourceMetadata = source === null ? null : await stat(source).catch(() => null);
    if (source === null || sourceMetadata === null || !sourceMetadata.isDirectory()) {
      throw new ScannerError("SCANNER_INPUT_FAILURE");
    }
    const inputs = await collectWorkflowInputs(source);
    if (inputs.length === 0) throw new ScannerError("SCANNER_INPUT_FAILURE");

    const staging = await stageWorkflowInputs(inputs);
    try {
      const result = await this.#runCommand(
        binary,
        [
          "--offline",
          "--no-config",
          "--no-ignores",
          "--persona=regular",
          "--collect=all",
          "--strict-collection",
          "--format=json-v1",
          staging,
        ],
        {
          cwd: "/",
          timeoutMs: this.#timeoutMs,
          stdoutLimitBytes: MAX_STDOUT_BYTES,
          stderrLimitBytes: MAX_STDERR_BYTES,
          acceptedExitCodes: [0, 3, 11, 12, 13, 14],
        },
      );

      if (result.exitCode === undefined || result.exitCode === 3) {
        throw new ScannerError("SCANNER_INVALID_OUTPUT");
      }
      let document: unknown;
      try {
        document = JSON.parse(outputDecoder.decode(result.stdout)) as unknown;
      } catch {
        throw new ScannerError("SCANNER_INVALID_OUTPUT");
      }
      const parsed = outputSchema.safeParse(document);
      if (!parsed.success) throw new ScannerError("SCANNER_INVALID_OUTPUT");

      const findings = parsed.data.map((finding) => {
        const { severity, confidence } = finding.determinations;
        if (zizmorVariantToken(finding.ident, severity, confidence) === null) {
          throw new ScannerError("SCANNER_INVALID_OUTPUT");
        }
        return { ident: finding.ident, severity, confidence };
      });

      if (result.exitCode === 0) {
        if (findings.length !== 0) {
          throw new ScannerError("SCANNER_INVALID_OUTPUT");
        }
      } else {
        const expectedSeverity = EXIT_SEVERITY.get(result.exitCode);
        const maximum = findings.reduce(
          (highest, finding) =>
            Math.max(highest, SEVERITY_RANK.get(finding.severity) ?? -1),
          -1,
        );
        if (
          expectedSeverity === undefined ||
          findings.length === 0 ||
          maximum !== SEVERITY_RANK.get(expectedSeverity)
        ) {
          throw new ScannerError("SCANNER_INVALID_OUTPUT");
        }
      }

      return {
        findings,
        rawFindingCount: findings.length,
        findingLimitExceeded: findings.length > ZIZMOR_INPUT_LIMITS.findings,
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
