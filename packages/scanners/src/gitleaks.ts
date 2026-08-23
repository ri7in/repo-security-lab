import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
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
import {
  MAX_LOCATIONS,
  REVIEW_MAX_FINDINGS,
  type FindingLocation,
  type ReviewFinding,
} from "@app/contracts";
import { buildReviewContext, reviewablePath } from "./review-context.js";
import {
  runScannerCommand,
  type ScannerCommandRunner,
} from "./command-runner.js";

export type { ScannerCommandRunner } from "./command-runner.js";

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
  // Location fields survive `--redact`; only the value itself is replaced.
  // They are parsed leniently because they feed the optional review channel,
  // and a malformed location must degrade to "unreviewable", never fail a scan.
  File: z.string().max(4_096).optional(),
  StartLine: z.number().int().nonnegative().optional(),
  Entropy: z.number().nonnegative().optional(),
});

export interface GitleaksScannerOptions {
  readonly binaryPath: string;
  readonly expectedBinarySha256: string;
  /** Capture bounded review context for each finding. Default false. */
  readonly collectReview?: boolean;
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
  /** Off unless the caller asked for review context. */
  readonly #collectReview: boolean;

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
    this.#runCommand = options.runCommand ?? runScannerCommand;
    this.#collectReview = options.collectReview ?? false;
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
    const parsedFindings = document.map((value) => {
      const parsed = findingSchema.safeParse(value);
      if (!parsed.success || gitleaksRuleToken(parsed.data.RuleID) === null) {
        throw new ScannerError("SCANNER_INVALID_OUTPUT");
      }
      return parsed.data;
    });
    const findings = parsedFindings.map((entry) => ({ ruleId: entry.RuleID }));
    const review = this.#collectReview
      ? await buildReview(parsedFindings, source)
      : undefined;
    // Always collected. Locations are what makes a report actionable, they
    // need no file reads, and an opt-in flag here is a footgun: a caller that
    // forgets it silently ships a report nobody can act on.
    const locations = buildLocations(parsedFindings, source);
    return {
      findings: findings.slice(0, MAX_FINDINGS),
      rawFindingCount: findings.length,
      findingLimitExceeded: findings.length > MAX_FINDINGS,
      ...(review === undefined
        ? {}
        : { review, reviewComplete: review.length === parsedFindings.length }),
      locations,
    };
  }
}

/**
 * Collects the published location of each finding.
 *
 * Unlike review context this reads no files: gitleaks already reported the
 * path and line, and the value itself was redacted before it ever reached us.
 * A path the channel refuses yields no location, and the finding is still
 * reported without one. A report may omit where something is; it may never
 * invent it.
 */
function buildLocations(
  parsed: readonly {
    RuleID: string;
    File?: string | undefined;
    StartLine?: number | undefined;
  }[],
  sourceDirectory: string,
): FindingLocation[] {
  const root = path.resolve(sourceDirectory);
  const locations: FindingLocation[] = [];
  for (const entry of parsed) {
    if (locations.length >= MAX_LOCATIONS) break;
    if (entry.File === undefined || entry.StartLine === undefined) continue;
    // Gitleaks echoes back whatever root it was given, so an absolute scan
    // root yields absolute paths. Publishing those would leak the scratch
    // directory layout, so a path is made repository-relative before it is
    // validated, and anything still outside the tree is dropped.
    const candidate = path.isAbsolute(entry.File)
      ? path.relative(root, path.resolve(entry.File))
      : entry.File;
    const relative = reviewablePath(candidate);
    if (relative === null) continue;
    locations.push({
      engine: "gitleaks",
      ruleId: entry.RuleID,
      path: relative,
      startLine: entry.StartLine,
    });
  }
  return locations;
}

/**
 * Builds review context for the findings worth reviewing.
 *
 * Files are read once each, however many findings they hold, and only the
 * first `REVIEW_MAX_FINDINGS` survive. A file that cannot be read, or a path
 * the channel refuses, simply yields no review entry: the finding is still
 * reported, it just goes unreviewed. Review may only ever remove a finding it
 * actually judged, so failing to build context must never silently drop one.
 */
async function buildReview(
  parsed: readonly {
    RuleID: string;
    File?: string | undefined;
    StartLine?: number | undefined;
    Entropy?: number | undefined;
  }[],
  sourceDirectory: string,
): Promise<ReviewFinding[]> {
  const review: ReviewFinding[] = [];
  const fileCache = new Map<string, readonly string[] | null>();

  for (const entry of parsed) {
    if (review.length >= REVIEW_MAX_FINDINGS) break;
    if (entry.File === undefined || entry.StartLine === undefined) continue;
    const relative = reviewablePath(entry.File);
    if (relative === null) continue;

    let lines = fileCache.get(relative);
    if (lines === undefined) {
      try {
        const absolute = path.resolve(sourceDirectory, relative);
        // Refuse anything that escapes the extracted tree. The archive guard
        // already rejects traversal, so this is defence in depth rather than
        // the primary control.
        const root = path.resolve(sourceDirectory);
        lines =
          absolute === root || absolute.startsWith(`${root}${path.sep}`)
            ? (await readFile(absolute, "utf8")).split("\n")
            : null;
      } catch {
        lines = null;
      }
      fileCache.set(relative, lines);
    }
    if (lines === null) continue;

    review.push({
      engine: "gitleaks",
      ruleId: entry.RuleID,
      path: relative,
      startLine: Math.max(1, entry.StartLine),
      entropy: Math.min(10, entry.Entropy ?? 0),
      contextLines: buildReviewContext(lines, Math.max(1, entry.StartLine)),
    });
  }
  return review;
}
