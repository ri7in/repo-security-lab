import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
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
  SPECIALISTS,
  type FailureClass,
  type OpaqueId,
  type RepositoryActiveState,
} from "@app/contracts";
import {
  canTransition,
  type ExhaustedLeaseRef,
  type LeaseRef,
  type RepositoryRecord,
  type SpecialistOutcomes,
  type Store,
} from "@app/core";
import {
  GithubClientError,
  type ArchiveDownload,
  type ArchiveRef,
} from "@app/github";
import { normalizeGitleaks, NormalizationError } from "@app/normalize";
import {
  ScannerError,
  type GitleaksScanResult,
} from "@app/scanners";

const DEFAULT_LEASE_DURATION_MS = 20 * 60 * 1_000;

export interface ArchiveFetcher {
  fetchArchive(input: ArchiveRef): Promise<ArchiveDownload>;
}

export interface SecretScanner {
  scan(sourceDirectory: string): Promise<GitleaksScanResult>;
}

export interface RepositoryWorkerOptions {
  readonly store: Store;
  readonly archiveFetcher: ArchiveFetcher;
  readonly gitleaks: SecretScanner;
  readonly gitleaksBroker: SourceBlindBroker;
  readonly workerId: OpaqueId;
  readonly scratchBase: string;
  readonly allowedGithubAccountIds: ReadonlySet<number>;
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
    if (error.code === "SCANNER_OUTPUT_LIMIT") return "SCANNER_OUTPUT_LIMIT";
    return "SCANNER_INTERNAL";
  }
  if (error instanceof GithubClientError) {
    if (error.code === "RATE_LIMITED") return "GITHUB_RATE_LIMIT";
    if (error.code === "ACCOUNT_NOT_FOUND") return "GITHUB_NOT_FOUND";
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
  readonly #store: Store;
  readonly #archiveFetcher: ArchiveFetcher;
  readonly #gitleaks: SecretScanner;
  readonly #gitleaksBroker: SourceBlindBroker;
  readonly #workerId: OpaqueId;
  readonly #scratchBase: string;
  readonly #allowedGithubAccountIds: ReadonlySet<number>;
  readonly #leaseDurationMs: number;
  readonly #now: () => number;
  readonly #removeScratch: (jobRoot: string) => Promise<boolean>;

  constructor(options: RepositoryWorkerOptions) {
    this.#store = options.store;
    this.#archiveFetcher = options.archiveFetcher;
    this.#gitleaks = options.gitleaks;
    this.#gitleaksBroker = options.gitleaksBroker;
    this.#workerId = options.workerId;
    this.#scratchBase = path.resolve(options.scratchBase);
    this.#allowedGithubAccountIds = options.allowedGithubAccountIds;
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#now = options.now ?? Date.now;
    this.#removeScratch = options.removeScratch ?? this.#defaultRemoveScratch;
    if (
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 10 * 60 * 1_000 ||
      this.#leaseDurationMs > DEFAULT_LEASE_DURATION_MS
    ) {
      throw new Error("invalid worker lease duration");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.#scratchBase, { recursive: true, mode: 0o700 });
    const configuredMetadata = await lstat(this.#scratchBase);
    if (!configuredMetadata.isDirectory() || configuredMetadata.isSymbolicLink()) {
      throw new Error("invalid worker scratch root");
    }
    const resolved = await realpath(this.#scratchBase);
    const metadata = await lstat(resolved);
    if (!metadata.isDirectory()) {
      throw new Error("invalid worker scratch root");
    }
    await chmod(resolved, 0o700);
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
    const request = await this.#store.getRequest(repository.requestId);
    if (
      request?.githubAccountId === null ||
      request === null ||
      !this.#allowedGithubAccountIds.has(request.githubAccountId) ||
      repository.isFork
    ) {
      const publication = await this.#store.publish({
        ...lease,
        terminalState: "cancelled",
        reason: "PRIVATE_SLICE_SCOPE",
        coverage,
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
      await extractTarGzip(createReadStream(archivePath), sourcePath);
      coverage.archive_guard = "complete";
      coverage.osv = "unsupported";
      coverage.zizmor = "unsupported";
      coverage.opengrep = "unsupported";
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
      const scanResult = await this.#gitleaks.scan(sourcePath);
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
      const normalized = normalizeGitleaks(scanResult);
      coverage.gitleaks = normalized.coverage;
      await advance("cleaning");
      sourceCleaned = await this.#removeScratch(jobRoot);
      if (!sourceCleaned) return "cleanup_pending";
      await advance("uploading");
      const findings = this.#gitleaksBroker.accept(normalized.packetBytes, {
        requestId: repository.requestId,
        repositoryId: repository.repositoryId,
        commitSha: repository.commitSha,
        ownerDetailRef: fixedOwnerDetailRef(reference),
      });
      await advance("waiting_to_publish");
      let publication;
      try {
        publication =
          normalized.coverage === "partial"
            ? await this.#store.publish({
                ...lease,
                terminalState: "partial",
                reason: "FINDING_LIMIT",
                coverage,
                findings,
                nowMs: this.#now(),
              })
            : await this.#store.publish({
                ...lease,
                terminalState: "complete",
                reason: null,
                coverage,
                findings,
                nowMs: this.#now(),
              });
      } catch {
        return "publish_deferred";
      }
      if (publication !== "published" && publication !== "idempotent") {
        return publication === "stale_lease" ? "stale_lease" : "publish_deferred";
      }
      return normalized.coverage === "partial" ? "partial" : "complete";
    } catch (error) {
      const reason = fixedFailure(error);
      if (coverage.snapshot !== "complete") coverage.snapshot = "failed";
      if (reason.startsWith("SCANNER_")) coverage.gitleaks = "failed";
      if (reason === "NORMALIZATION_REJECTED") coverage.gitleaks = "failed";
      if (reason.startsWith("ARCHIVE_") && coverage.snapshot === "complete") {
        coverage.archive_guard = "failed";
      }

      if (!sourceCleaned) {
        if (canTransition(state, "cleaning")) {
          try {
            await advance("cleaning");
          } catch {
            return "stale_lease";
          }
        }
        sourceCleaned = jobRootCreated
          ? await this.#removeScratch(jobRoot)
          : true;
      }
      if (!sourceCleaned && jobRootCreated) return "cleanup_pending";
      if (!canTransition(state, "failed")) return "stale_lease";
      try {
        const publication = await this.#store.publish({
          ...lease,
          terminalState: "failed",
          reason,
          coverage,
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
