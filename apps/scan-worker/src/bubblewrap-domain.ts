import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  guardDomainResultSchema,
  scanDomainProbeResultSchema,
  scanDomainResultSchema,
  type ScanEngine,
} from "@app/contracts";
import { ArchiveError } from "@app/archive";
import { NormalizationError, type NormalizedResult } from "@app/normalize";
import {
  runScannerCommand,
  ScannerError,
  type ScannerCommandRunner,
} from "@app/scanners";
import type {
  RepositoryScanDomain,
  ScanDomainEngineResult,
} from "@app/worker";

const MAX_DOMAIN_RESULT_BYTES = 320 * 1_024;
const encoder = new TextEncoder();

export interface BubblewrapDomainOptions {
  readonly bubblewrapPath: string;
  readonly nodePath: string;
  readonly applicationBundlePath: string;
  readonly gitleaksBinaryPath: string;
  readonly gitleaksConfigPath: string;
  readonly gitleaksIgnorePath: string;
  readonly gitleaksSha256: string;
  readonly zizmorBinaryPath?: string;
  readonly zizmorSha256?: string;
  /** Exact dynamic-loader/library roots determined by the OCI image proof. */
  readonly runtimeLibraryPaths: readonly string[];
  readonly runCommand?: ScannerCommandRunner;
}

interface VerifiedIsolationPaths {
  readonly bubblewrap: string;
  readonly node: string;
  readonly applicationBundle: string;
  readonly gitleaksBinary: string;
  readonly gitleaksConfig: string;
  readonly gitleaksIgnore: string;
}

async function trustedPath(
  filename: string,
  kind: "file" | "directory",
  allowSymlink = false,
  label = "job-input",
): Promise<string> {
  if (!path.isAbsolute(filename)) throw new Error(`invalid isolation path:${label}`);
  const suppliedMetadata = await lstat(filename);
  if (!allowSymlink && suppliedMetadata.isSymbolicLink()) {
    throw new Error(`invalid isolation path:${label}`);
  }
  const resolved = await realpath(filename);
  const metadata = await lstat(resolved);
  if (
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    (kind === "file" ? !metadata.isFile() : !metadata.isDirectory())
  ) {
    throw new Error(`invalid isolation path:${label}`);
  }
  return resolved;
}

async function boundedJson(filename: string): Promise<unknown> {
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 2 ||
    metadata.size > MAX_DOMAIN_RESULT_BYTES
  ) {
    throw new NormalizationError();
  }
  return JSON.parse(await readFile(filename, "utf8")) as unknown;
}

export class BubblewrapRepositoryScanDomain implements RepositoryScanDomain {
  readonly #options: BubblewrapDomainOptions;
  readonly #runCommand: ScannerCommandRunner;
  #verified: Promise<void> | null = null;
  #isVerified = false;
  #verifiedPaths: VerifiedIsolationPaths | null = null;
  #runtimeLibraryMounts: readonly {
    readonly source: string;
    readonly target: string;
  }[] = [];
  #verifiedZizmorBinary: string | null = null;

  get enforcedIsolation(): boolean {
    return this.#isVerified;
  }

  constructor(options: BubblewrapDomainOptions) {
    if (!/^[a-f0-9]{64}$/u.test(options.gitleaksSha256)) {
      throw new Error("invalid isolation scanner identity");
    }
    if (
      (options.zizmorBinaryPath === undefined) !==
        (options.zizmorSha256 === undefined) ||
      (options.zizmorSha256 !== undefined &&
        !/^[a-f0-9]{64}$/u.test(options.zizmorSha256))
    ) {
      throw new Error("invalid isolation scanner identity");
    }
    if (options.runtimeLibraryPaths.length < 1) {
      throw new Error("missing isolation runtime libraries");
    }
    this.#options = Object.freeze({
      ...options,
      runtimeLibraryPaths: Object.freeze([...options.runtimeLibraryPaths]),
    });
    this.#runCommand = options.runCommand ?? runScannerCommand;
  }

  async verify(): Promise<void> {
    this.#verified ??= this.#verifyOnce();
    try {
      await this.#verified;
      this.#isVerified = true;
    } catch (error) {
      this.#verified = null;
      this.#isVerified = false;
      this.#verifiedPaths = null;
      this.#runtimeLibraryMounts = [];
      this.#verifiedZizmorBinary = null;
      throw error;
    }
  }

  async #verifyOnce(): Promise<void> {
    const [
      bubblewrap,
      node,
      applicationBundle,
      gitleaksBinary,
      gitleaksConfig,
      gitleaksIgnore,
    ] = await Promise.all([
      trustedPath(this.#options.bubblewrapPath, "file", true, "bubblewrap"),
      trustedPath(this.#options.nodePath, "file", true, "node"),
      trustedPath(this.#options.applicationBundlePath, "file", false, "bundle"),
      trustedPath(this.#options.gitleaksBinaryPath, "file", false, "gitleaks"),
      trustedPath(this.#options.gitleaksConfigPath, "file", false, "config"),
      trustedPath(this.#options.gitleaksIgnorePath, "file", false, "ignore"),
    ]);
    this.#verifiedPaths = Object.freeze({
      bubblewrap,
      node,
      applicationBundle,
      gitleaksBinary,
      gitleaksConfig,
      gitleaksIgnore,
    });
    this.#verifiedZizmorBinary =
      this.#options.zizmorBinaryPath === undefined
        ? null
        : await trustedPath(this.#options.zizmorBinaryPath, "file", false, "zizmor");
    const runtimeSources = await Promise.all(
      this.#options.runtimeLibraryPaths.map((entry) =>
        trustedPath(entry, "directory", true, "runtime-library"),
      ),
    );
    this.#runtimeLibraryMounts = Object.freeze(
      this.#options.runtimeLibraryPaths.map((target, index) => ({
        source: runtimeSources[index] ?? "",
        target: path.normalize(target),
      })),
    );
    const version = await this.#runCommand(
      this.#verifiedPaths.bubblewrap,
      ["--version"],
      {
        cwd: "/",
        timeoutMs: 5_000,
        stdoutLimitBytes: 1_024,
        stderrLimitBytes: 1_024,
      },
    );
    if (!/^bubblewrap \d+\.\d+\.\d+\s*$/u.test(version.stdout.toString("utf8"))) {
      throw new Error("invalid bubblewrap runtime");
    }
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "repo-security-probe-"));
    try {
      await this.#runCommand(
        this.#verifiedPaths.bubblewrap,
        [
          ...this.#baseArguments(outputDirectory),
          "--remount-ro",
          "/",
          "--chdir",
          "/work",
          "/runtime/bin/node",
          "/app/scan-domain.mjs",
          "probe",
        ],
        {
          cwd: "/",
          timeoutMs: 5_000,
          stdoutLimitBytes: 1_024,
          stderrLimitBytes: 4 * 1_024,
        },
      );
      scanDomainProbeResultSchema.parse(
        await boundedJson(path.join(outputDirectory, "result.json")),
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }

  #baseArguments(outputDirectory: string): string[] {
    if (this.#verifiedPaths === null) {
      throw new Error("isolation paths are not verified");
    }
    const zizmorEnvironment =
      this.#verifiedZizmorBinary !== null &&
      this.#options.zizmorSha256 !== undefined
        ? ["--setenv", "ZIZMOR_SHA256", this.#options.zizmorSha256]
        : [];
    const argumentsList = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--setenv",
      "HOME",
      "/nonexistent",
      "--setenv",
      "LANG",
      "C",
      "--setenv",
      "LC_ALL",
      "C",
      "--setenv",
      "PATH",
      "/runtime/bin:/tools",
      "--setenv",
      "PWD",
      "/work",
      "--setenv",
      "GITLEAKS_SHA256",
      this.#options.gitleaksSha256,
      ...zizmorEnvironment,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/runtime",
      "--dir",
      "/runtime/bin",
      "--dir",
      "/app",
      "--dir",
      "/tools",
      "--dir",
      "/config",
      "--dir",
      "/input",
      "--dir",
      "/output",
      "--dir",
      "/work",
      "--ro-bind",
      this.#verifiedPaths.node,
      "/runtime/bin/node",
      "--ro-bind",
      this.#verifiedPaths.applicationBundle,
      "/app/scan-domain.mjs",
      "--ro-bind",
      this.#verifiedPaths.gitleaksBinary,
      "/tools/gitleaks",
      "--ro-bind",
      this.#verifiedPaths.gitleaksConfig,
      "/config/gitleaks.toml",
      "--ro-bind",
      this.#verifiedPaths.gitleaksIgnore,
      "/config/gitleaks.ignore",
      "--bind",
      outputDirectory,
      "/output",
    ];
    if (
      this.#verifiedZizmorBinary !== null &&
      this.#options.zizmorSha256 !== undefined
    ) {
      argumentsList.push(
        "--ro-bind",
        this.#verifiedZizmorBinary,
        "/tools/zizmor",
      );
    }
    for (const mount of this.#runtimeLibraryMounts) {
      argumentsList.push("--ro-bind", mount.source, mount.target);
    }
    return argumentsList;
  }

  async #run(
    mode: "guard" | "scan",
    argumentsList: readonly string[],
    outputDirectory: string,
  ): Promise<unknown> {
    await this.verify();
    if (this.#verifiedPaths === null) {
      throw new Error("isolation paths are not verified");
    }
    await this.#runCommand(
      this.#verifiedPaths.bubblewrap,
      [
        ...this.#baseArguments(outputDirectory),
        ...argumentsList,
        "--remount-ro",
        "/",
        "--chdir",
        "/work",
        "/runtime/bin/node",
        "/app/scan-domain.mjs",
        mode,
      ],
      {
        cwd: "/",
        timeoutMs: mode === "guard" ? 120_000 : 360_000,
        stdoutLimitBytes: 1_024,
        stderrLimitBytes: 4 * 1_024,
      },
    );
    return boundedJson(path.join(outputDirectory, "result.json"));
  }

  async guardAndExtract(archivePath: string, sourcePath: string): Promise<void> {
    if (path.basename(sourcePath) !== "source") throw new ArchiveError("ARCHIVE_INVALID");
    const jobRoot = path.dirname(sourcePath);
    const outputDirectory = await mkdtemp(path.join(jobRoot, ".guard-output-"));
    try {
      const result = guardDomainResultSchema.parse(
        await this.#run(
          "guard",
          [
            "--ro-bind",
            await trustedPath(archivePath, "file"),
            "/input/inbound.tar.gz",
            "--bind",
            await trustedPath(jobRoot, "directory"),
            "/work",
          ],
          outputDirectory,
        ),
      );
      if (!result.ok) throw new ArchiveError(result.reason);
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw new ArchiveError("ARCHIVE_INVALID");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }

  async scan(sourcePath: string): Promise<{
    readonly applicability: { readonly osv: boolean; readonly zizmor: boolean; readonly opengrep: boolean };
    readonly engineResults: readonly ScanDomainEngineResult[];
    readonly engineFailures: Readonly<Partial<Record<ScanEngine, import("@app/contracts").FailureClass>>>;
    readonly locations: readonly import("@app/contracts").FindingLocation[];
    readonly review: readonly import("@app/contracts").ReviewFinding[];
    readonly reviewComplete: boolean;
  }> {
    const source = await trustedPath(sourcePath, "directory");
    const outputDirectory = await mkdtemp(
      path.join(path.dirname(sourcePath), ".scan-output-"),
    );
    try {
      const result = scanDomainResultSchema.parse(
        await this.#run(
          "scan",
          ["--ro-bind", source, "/work/source"],
          outputDirectory,
        ),
      );
      const engineResults = result.engineResults.map((entry) => {
        const normalized: NormalizedResult = {
          packetBytes: encoder.encode(JSON.stringify(entry.packet)),
          coverage: entry.coverage,
          reason: entry.reason,
          ...(entry.counts === undefined ? {} : { counts: entry.counts }),
        };
        return { engine: entry.engine, normalized };
      });
      return {
        applicability: result.applicability,
        engineResults,
        engineFailures: result.engineFailures,
        locations: result.locations ?? [],
        review: result.review ?? [],
        reviewComplete: result.reviewComplete ?? false,
      };
    } catch (error) {
      if (error instanceof ScannerError) throw error;
      throw new NormalizationError();
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}
