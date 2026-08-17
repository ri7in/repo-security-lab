import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { extractTarGzip, ArchiveError } from "@app/archive";
import { BrokerError, type SourceBlindBroker } from "@app/broker";
import {
  SCAN_ENGINES,
  SPECIALISTS,
  type FailureClass,
  type OpaqueId,
  type RepositoryActiveState,
  type ScanEngine,
} from "@app/contracts";
import {
  canTransition,
  MAX_LEASE_ATTEMPTS,
  type ExhaustedLeaseRef,
  type LeaseRef,
  type RepositoryRecord,
  type SpecialistOutcomes,
  type WorkerStorePort,
} from "@app/core";
import {
  GithubClientError,
  type ArchiveDownload,
  type ArchiveRef,
} from "@app/github";
import {
  normalizeGitleaks,
  NormalizationError,
  type NormalizedResult,
} from "@app/normalize";
import {
  ScannerError,
  type GitleaksScanResult,
} from "@app/scanners";
import {
  detectSpecialistApplicability,
  type SpecialistApplicability,
} from "./applicability.js";

const DEFAULT_LEASE_DURATION_MS = 20 * 60 * 1_000;

export interface ArchiveFetcher {
  fetchArchive(input: ArchiveRef): Promise<ArchiveDownload>;
}

export interface SecretScanner {
  scan(sourceDirectory: string): Promise<GitleaksScanResult>;
}

export interface ScanDomainEngineResult {
  readonly engine: ScanEngine;
  readonly normalized: NormalizedResult;
}

export interface RepositoryScanDomain {
  /** True only after the implementation's startup escape probes pass. */
  readonly enforcedIsolation: boolean;
  guardAndExtract(archivePath: string, sourcePath: string): Promise<void>;
  scan(sourcePath: string): Promise<{
    readonly applicability: SpecialistApplicability;
    readonly engineResults: readonly ScanDomainEngineResult[];
    readonly engineFailures: Readonly<Partial<Record<ScanEngine, FailureClass>>>;
  }>;
}

export type AdditionalScanEngine = Exclude<ScanEngine, "gitleaks">;

/** Hostile-domain adapter output is already reduced to the numeric packet. */
export interface AdditionalEngineRunner {
  readonly engine: AdditionalScanEngine;
  readonly broker: SourceBlindBroker;
  /** Omitted when normalization runs wholly inside an isolated scan domain. */
  scanAndNormalize?(sourceDirectory: string): Promise<NormalizedResult>;
}

export interface RepositoryWorkerOptions {
  readonly store: WorkerStorePort;
  readonly archiveFetcher: ArchiveFetcher;
  readonly gitleaks?: SecretScanner;
  readonly gitleaksBroker: SourceBlindBroker;
  readonly additionalEngines?: readonly AdditionalEngineRunner[];
  readonly scanDomain?: RepositoryScanDomain;
  readonly workerId: OpaqueId;
  readonly scratchBase: string;
  /** Null enables the isolated public worker; a set retains private-slice scope. */
  readonly allowedGithubAccountIds: ReadonlySet<number> | null;
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly removeScratch?: (jobRoot: string) => Promise<boolean>;
}

export const WORK_RESULTS = [
  "idle",
  "complete",
  "partial",
  "failed",
  "scope_refused",
  "stale_lease",
  "cleanup_pending",
  "publish_deferred",
  "retry_queued",
] as const;
export type WorkResult = (typeof WORK_RESULTS)[number];

function leaseRef(repository: RepositoryRecord, workerId: OpaqueId): LeaseRef {
  if (repository.lease === null) throw new Error("claimed repository lacks lease");
  return {
    requestId: repository.requestId,
    repositoryId: repository.repositoryId,
    workerId,
    generation: repository.lease.generation,
  };
}

function initialCoverage(): Record<(typeof SPECIALISTS)[number], "not_applicable"> {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [specialist, "not_applicable"]),
  ) as Record<(typeof SPECIALISTS)[number], "not_applicable">;
}

function fixedOwnerDetailRef(reference: ExhaustedLeaseRef): OpaqueId {
  const digest = createHash("sha256")
    .update(`${reference.requestId}\0${reference.repositoryId}\0${reference.generation}`)
    .digest("hex")
    .slice(0, 20);
  return `detail_${digest}`;
}

export function scratchPathFor(
  scratchBase: string,
  reference: ExhaustedLeaseRef,
): string {
  return path.join(
    scratchBase,
    `job_${reference.requestId}_${reference.repositoryId}_${reference.generation}`,
  );
}

function fixedFailure(error: unknown): FailureClass {
  if (error instanceof ArchiveError) return error.code;
  if (error instanceof NormalizationError) return "NORMALIZATION_REJECTED";
  if (error instanceof BrokerError) return "NORMALIZATION_REJECTED";
  if (error instanceof ScannerError) {
    if (error.code === "SCANNER_TIMEOUT") return "SCANNER_TIMEOUT";
    if (error.code === "SCANNER_MEMORY_LIMIT") return "SCANNER_MEMORY_LIMIT";
    if (error.code === "SCANNER_OUTPUT_LIMIT") return "SCANNER_OUTPUT_LIMIT";
    return "SCANNER_INTERNAL";
  }
  if (error instanceof GithubClientError) {
    if (error.code === "RATE_LIMITED") return "GITHUB_RATE_LIMIT";
    if (error.code === "ACCOUNT_NOT_FOUND") return "GITHUB_NOT_FOUND";
    if (error.code === "NETWORK_FAILED" || error.code === "UPSTREAM_FAILED") {
      return "GITHUB_NETWORK";
    }
    if (error.code === "AUTH_REQUIRED") return "GITHUB_AUTH";
    if (error.code === "REPOSITORY_CHANGED") return "REPOSITORY_CHANGED";
    if (error.code === "ARCHIVE_LIMIT") return "ARCHIVE_LIMIT";
    if (error.code === "ARCHIVE_INVALID") return "ARCHIVE_INVALID";
    return "ARCHIVE_INVALID";
  }
  return "SCANNER_INTERNAL";
}

async function* webStreamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let complete = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class RepositoryWorker {
  readonly #store: WorkerStorePort;
  readonly #archiveFetcher: ArchiveFetcher;
  readonly #gitleaks: SecretScanner | null;
  readonly #gitleaksBroker: SourceBlindBroker;
  readonly #additionalEngines: readonly AdditionalEngineRunner[];
  readonly #scanDomain: RepositoryScanDomain | null;
  readonly #workerId: OpaqueId;
  readonly #scratchBase: string;
  readonly #allowedGithubAccountIds: ReadonlySet<number> | null;
  readonly #leaseDurationMs: number;
  readonly #now: () => number;
  readonly #removeScratch: (jobRoot: string) => Promise<boolean>;

  constructor(options: RepositoryWorkerOptions) {
    this.#store = options.store;
    this.#archiveFetcher = options.archiveFetcher;
    this.#gitleaks = options.gitleaks ?? null;
    this.#gitleaksBroker = options.gitleaksBroker;
    this.#additionalEngines = Object.freeze([...(options.additionalEngines ?? [])]);
    this.#scanDomain = options.scanDomain ?? null;
    this.#workerId = options.workerId;
    this.#scratchBase = path.resolve(options.scratchBase);
    this.#allowedGithubAccountIds = options.allowedGithubAccountIds;
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#now = options.now ?? Date.now;
    this.#removeScratch = options.removeScratch ?? this.#defaultRemoveScratch;
    const additionalNames = this.#additionalEngines.map((runner) => runner.engine);
    if (
      additionalNames.some((engine) => engine === ("gitleaks" as ScanEngine)) ||
      new Set(additionalNames).size !== additionalNames.length
    ) {
      throw new Error("invalid additional engine configuration");
    }
    if (this.#scanDomain === null && this.#gitleaks === null) {
      throw new Error("missing scan domain");
    }
    if (
      this.#allowedGithubAccountIds === null &&
      (this.#scanDomain === null || !this.#scanDomain.enforcedIsolation)
    ) {
      throw new Error("public worker requires enforced scan isolation");
    }
    if (
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 10 * 60 * 1_000 ||
      this.#leaseDurationMs > DEFAULT_LEASE_DURATION_MS
    ) {
      throw new Error("invalid worker lease duration");
    }
  }

  async initialize(): Promise<void> {
    if (this.#scratchBase === path.parse(this.#scratchBase).root) {
      throw new Error("invalid worker scratch root");
    }
    await mkdir(this.#scratchBase, { recursive: true, mode: 0o700 });
    const configuredMetadata = await lstat(this.#scratchBase);
    if (
      !configuredMetadata.isDirectory() ||
      configuredMetadata.isSymbolicLink() ||
      (configuredMetadata.mode & 0o077) !== 0
    ) {
      throw new Error("invalid worker scratch root");
    }
    const resolved = await realpath(this.#scratchBase);
    const metadata = await lstat(resolved);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
      throw new Error("invalid worker scratch root");
    }
  }

  /** Call only during single-worker startup, before any lease is claimed. */
  async cleanStartupOrphans(): Promise<number> {
    await this.initialize();
    let removed = 0;
    for (const entry of await readdir(this.#scratchBase, { withFileTypes: true })) {
      if (entry.name.startsWith("job_") && entry.isDirectory()) {
        const candidate = path.join(this.#scratchBase, entry.name);
        if (await this.#removeScratch(candidate)) removed += 1;
      }
    }
    return removed;
  }

  async reapExpired(): Promise<{ requeuedCleaned: number; exhaustedFinalized: number }> {
    const result = await this.#store.classifyExpiredLeases(this.#now());
    let requeuedCleaned = 0;
    let exhaustedFinalized = 0;
    for (const reference of result.retryable) {
      if (
        (await this.#removeScratch(scratchPathFor(this.#scratchBase, reference))) &&
        (await this.#store.requeueCleaned({
          ...reference,
          nowMs: this.#now(),
        }))
      ) {
        requeuedCleaned += 1;
      }
    }
    for (const reference of result.exhausted) {
      if (
        (await this.#removeScratch(scratchPathFor(this.#scratchBase, reference))) &&
        (await this.#store.finalizeExhausted({
          ...reference,
          nowMs: this.#now(),
        }))
      ) {
        exhaustedFinalized += 1;
      }
    }
    return { requeuedCleaned, exhaustedFinalized };
  }

  async runOne(): Promise<WorkResult> {
    await this.initialize();
    const repository = await this.#store.claimNext({
      workerId: this.#workerId,
      nowMs: this.#now(),
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (repository === null) return "idle";
    const lease = leaseRef(repository, this.#workerId);
    const reference: ExhaustedLeaseRef = {
      requestId: lease.requestId,
      repositoryId: lease.repositoryId,
      generation: lease.generation,
    };
    const coverage = initialCoverage() as Record<
      (typeof SPECIALISTS)[number],
      SpecialistOutcomes[(typeof SPECIALISTS)[number]]
    >;
    const specialistReasons: Partial<Record<ScanEngine, FailureClass>> = {};
    const request = await this.#store.getRequest(repository.requestId);
    if (
      request?.githubAccountId === null ||
      request === null ||
      (this.#allowedGithubAccountIds !== null &&
        !this.#allowedGithubAccountIds.has(request.githubAccountId)) ||
      repository.isFork
    ) {
      const publication = await this.#store.publish({
        ...lease,
        terminalState: "cancelled",
        reason: "PRIVATE_SLICE_SCOPE",
        coverage,
        specialistReasons,
        findings: [],
        nowMs: this.#now(),
      });
      return publication === "published" ? "scope_refused" : "stale_lease";
    }
    if (repository.commitSha === null) return "stale_lease";

    const jobRoot = scratchPathFor(this.#scratchBase, reference);
    const archivePath = path.join(jobRoot, "inbound.tar.gz");
    const sourcePath = path.join(jobRoot, "source");
    let jobRootCreated = false;
    let sourceCleaned = false;
    let state: RepositoryActiveState = "leased";
    let detected: SpecialistApplicability | null | undefined;

    const advance = async (nextState: RepositoryActiveState): Promise<void> => {
      if (!canTransition(state, nextState)) throw new Error("invalid worker state");
      const changed = await this.#store.transition({
        ...lease,
        expectedState: state,
        nextState,
        nowMs: this.#now(),
      });
      if (!changed) throw new Error("stale worker lease");
      state = nextState;
    };

    try {
      await advance("acquiring");
      // From this point the exact tuple path is worker-owned even if mkdir
      // discovers an orphan. Any failure must remove and verify that path
      // before publication.
      jobRootCreated = true;
      await mkdir(jobRoot, { mode: 0o700 });
      const download = await this.#archiveFetcher.fetchArchive({
        owner: request.username,
        repository: repository.name,
        commitSha: repository.commitSha,
      });
      await pipeline(
        Readable.from(webStreamChunks(download.body)),
        createWriteStream(archivePath, {
          flags: "wx",
          mode: 0o600,
        }),
      );
      coverage.snapshot = "complete";
      await advance("guarding");
      if (this.#scanDomain === null) {
        await extractTarGzip(createReadStream(archivePath), sourcePath);
      } else {
        await this.#scanDomain.guardAndExtract(archivePath, sourcePath);
      }
      coverage.archive_guard = "complete";
      await advance("scanning");
      if (
        !(await this.#store.heartbeat({
          ...lease,
          nowMs: this.#now(),
          leaseDurationMs: this.#leaseDurationMs,
        }))
      ) {
        throw new Error("stale worker lease");
      }
      const normalizedByEngine = new Map<
        ScanEngine,
        { readonly normalized: NormalizedResult; readonly broker: SourceBlindBroker }
      >();
      if (this.#scanDomain !== null) {
        const result = await this.#scanDomain.scan(sourcePath);
        detected = result.applicability;
        coverage.osv = detected.osv === false ? "not_applicable" : "unsupported";
        coverage.zizmor =
          detected.zizmor === false ? "not_applicable" : "unsupported";
        coverage.opengrep =
          detected.opengrep === false ? "not_applicable" : "unsupported";
        for (const engineResult of result.engineResults) {
          const broker =
            engineResult.engine === "gitleaks"
              ? this.#gitleaksBroker
              : this.#additionalEngines.find(
                  (runner) => runner.engine === engineResult.engine,
                )?.broker;
          if (broker === undefined || normalizedByEngine.has(engineResult.engine)) {
            throw new NormalizationError();
          }
          coverage[engineResult.engine] = engineResult.normalized.coverage;
          normalizedByEngine.set(engineResult.engine, {
            normalized: engineResult.normalized,
            broker,
          });
        }
        for (const [engine, reason] of Object.entries(result.engineFailures)) {
          const scanEngine = engine as ScanEngine;
          coverage[scanEngine] = "failed";
          specialistReasons[scanEngine] = reason;
        }
        if (
          !normalizedByEngine.has("gitleaks") &&
          specialistReasons.gitleaks === undefined
        ) {
          throw new NormalizationError();
        }
      } else {
        detected = await detectSpecialistApplicability(sourcePath);
        coverage.osv = detected?.osv === false ? "not_applicable" : "unsupported";
        coverage.zizmor =
          detected?.zizmor === false ? "not_applicable" : "unsupported";
        coverage.opengrep =
          detected?.opengrep === false ? "not_applicable" : "unsupported";
        try {
          const scanResult = await this.#gitleaks!.scan(sourcePath);
          const normalized = normalizeGitleaks(scanResult);
          coverage.gitleaks = normalized.coverage;
          normalizedByEngine.set("gitleaks", {
            normalized,
            broker: this.#gitleaksBroker,
          });
        } catch (error) {
          coverage.gitleaks = "failed";
          specialistReasons.gitleaks = fixedFailure(error);
        }
        for (const runner of this.#additionalEngines) {
          if (
            detected?.[runner.engine] !== true ||
            runner.scanAndNormalize === undefined
          ) continue;
          if (
            !(await this.#store.heartbeat({
              ...lease,
              nowMs: this.#now(),
              leaseDurationMs: this.#leaseDurationMs,
            }))
          ) {
            throw new Error("stale worker lease");
          }
          try {
            const normalized = await runner.scanAndNormalize(sourcePath);
            if (
              (normalized.coverage === "complete" && normalized.reason !== null) ||
              (normalized.coverage === "partial" &&
                normalized.reason !== "FINDING_LIMIT")
            ) {
              throw new NormalizationError();
            }
            coverage[runner.engine] = normalized.coverage;
            normalizedByEngine.set(runner.engine, {
              normalized,
              broker: runner.broker,
            });
          } catch (error) {
            coverage[runner.engine] = "failed";
            specialistReasons[runner.engine] = fixedFailure(error);
          }
        }
      }
      if (
        !(await this.#store.heartbeat({
          ...lease,
          nowMs: this.#now(),
          leaseDurationMs: this.#leaseDurationMs,
        }))
      ) {
        throw new Error("stale worker lease");
      }
      await advance("normalizing");
      await advance("cleaning");
      sourceCleaned = await this.#removeScratch(jobRoot);
      if (!sourceCleaned) return "cleanup_pending";
      await advance("uploading");
      const findings = [];
      for (const [engine, result] of normalizedByEngine) {
        try {
          const accepted = result.broker.accept(result.normalized.packetBytes, {
            requestId: repository.requestId,
            repositoryId: repository.repositoryId,
            commitSha: repository.commitSha,
            ownerDetailRef: fixedOwnerDetailRef(reference),
          });
          if (accepted.some((finding) => finding.engine !== engine)) {
            throw new BrokerError();
          }
          findings.push(...accepted);
        } catch {
          coverage[engine] = "failed";
          specialistReasons[engine] = "NORMALIZATION_REJECTED";
        }
      }
      await advance("waiting_to_publish");
      const successfulEngines = SCAN_ENGINES.filter((engine) =>
        ["complete", "partial"].includes(coverage[engine]),
      );
      const failedEngine = SCAN_ENGINES.find(
        (engine) => coverage[engine] === "failed",
      );
      const hasPartialEngine = SCAN_ENGINES.some(
        (engine) => coverage[engine] === "partial",
      );
      let publication;
      try {
        if (successfulEngines.length === 0) {
          publication = await this.#store.publish({
            ...lease,
            terminalState: "failed",
            reason:
              (failedEngine === undefined
                ? undefined
                : specialistReasons[failedEngine]) ?? "SCANNER_INTERNAL",
            coverage,
            specialistReasons,
            findings: [],
            nowMs: this.#now(),
          });
        } else if (failedEngine !== undefined || hasPartialEngine) {
          publication = await this.#store.publish({
            ...lease,
            terminalState: "partial",
            reason:
              (failedEngine === undefined
                ? undefined
                : specialistReasons[failedEngine]) ?? "FINDING_LIMIT",
            coverage,
            specialistReasons,
            findings,
            nowMs: this.#now(),
          });
        } else {
          publication = await this.#store.publish({
            ...lease,
            terminalState: "complete",
            reason: null,
            coverage,
            specialistReasons,
            findings,
            nowMs: this.#now(),
          });
        }
      } catch {
        return "publish_deferred";
      }
      if (publication !== "published" && publication !== "idempotent") {
        return publication === "stale_lease" ? "stale_lease" : "publish_deferred";
      }
      return successfulEngines.length === 0
        ? "failed"
        : failedEngine !== undefined || hasPartialEngine
          ? "partial"
          : "complete";
    } catch (error) {
      const reason = fixedFailure(error);
      if (coverage.snapshot !== "complete") coverage.snapshot = "failed";
      if (reason.startsWith("SCANNER_") && coverage.gitleaks === "not_applicable") {
        coverage.gitleaks = "failed";
      }
      if (
        reason === "NORMALIZATION_REJECTED" &&
        coverage.gitleaks === "not_applicable"
      ) {
        coverage.gitleaks = "failed";
      }
      if (!sourceCleaned) {
        if (canTransition(state, "cleaning")) {
          try {
            await advance("cleaning");
          } catch {
            // The lease can expire after local source exists but before the
            // durable cleaning transition. Remove the exact generation now;
            // the janitor's later CAS will observe the already-absent path and
            // safely requeue/finalize it. Do not leave source until that tick.
            sourceCleaned = jobRootCreated
              ? await this.#removeScratch(jobRoot)
              : true;
            return sourceCleaned ? "stale_lease" : "cleanup_pending";
          }
        }
        sourceCleaned = jobRootCreated
          ? await this.#removeScratch(jobRoot)
          : true;
      }
      if (!sourceCleaned && jobRootCreated) return "cleanup_pending";
      if (
        (reason === "GITHUB_RATE_LIMIT" || reason === "GITHUB_NETWORK") &&
        repository.attemptCount < MAX_LEASE_ATTEMPTS
      ) {
        try {
          const queued = await this.#store.retryCleaned({
            ...lease,
            nowMs: this.#now(),
          });
          return queued ? "retry_queued" : "stale_lease";
        } catch {
          return "stale_lease";
        }
      }
      if (
        SCAN_ENGINES.some((engine) =>
          ["complete", "partial"].includes(coverage[engine]),
        )
      ) {
        // A late failed transition cannot truthfully turn already-successful
        // engine coverage into a failed publication. Leave the exact lease
        // generation for the janitor instead of entering that invalid state.
        return "stale_lease";
      }
      if (!canTransition(state, "failed")) return "stale_lease";
      if (coverage.archive_guard === "not_applicable") {
        coverage.archive_guard = "failed";
      }
      if (coverage.gitleaks === "not_applicable") coverage.gitleaks = "failed";
      if (detected === undefined || detected === null) {
        coverage.osv = "failed";
        coverage.zizmor = "failed";
        coverage.opengrep = "failed";
      }
      try {
        const publication = await this.#store.publish({
          ...lease,
          terminalState: "failed",
          reason,
          coverage,
          specialistReasons,
          findings: [],
          nowMs: this.#now(),
        });
        return publication === "published" ? "failed" : "stale_lease";
      } catch {
        return "publish_deferred";
      }
    }
  }

  async #defaultRemoveScratch(jobRoot: string): Promise<boolean> {
    try {
      await rm(jobRoot, { recursive: true, force: true });
      await lstat(jobRoot);
      return false;
    } catch (error) {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      );
    }
  }
}
