import { createReadStream, createWriteStream } from "node:fs";
import {
  reviewScannerFindings,
  type FindingReviewOutcome,
  type JudgePort,
  type ScoutPort,
} from "@app/ai";
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
import { runAiEngine } from "./ai-engine.js";
import { extractTarGzip, ArchiveError } from "@app/archive";
import { BrokerError, SourceBlindBroker } from "@app/broker";
import {
  SCAN_ENGINES,
  SPECIALISTS,
  type FailureClass,
  type OpaqueId,
  type RepositoryActiveState,
  type ScanEngine,
  MAX_LOCATIONS_PER_FINDING,
  brokerResultPacketSchema,
  type BrokerDerivedFinding,
  type FindingLocation,
  type ReviewFinding,
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
  bucketForCount,
  normalizeGitleaks,
  NormalizationError,
  type NormalizedResult,
} from "@app/normalize";
import {
  ScannerError,
  type GitleaksScanResult,
  AI_BROKER_MANIFEST,
  gitleaksRuleToken,
} from "@app/scanners";
import {
  detectSpecialistApplicability,
  type SpecialistApplicability,
} from "./applicability.js";

/**
 * Tokens of source a single repository may cost the reader.
 *
 * Sized well under the smallest free context window in the panel, because the
 * constraint that binds is the daily allowance, not the window: a pack that
 * fills a context also empties the day in a handful of repositories.
 */
const AI_TOKEN_BUDGET = 120_000;


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
    /** Where each finding sits. Optional so older domains keep compiling. */
    readonly locations?: readonly FindingLocation[];
    /** Bounded excerpts for council review. Never published. */
    readonly review?: readonly ReviewFinding[];
    /** True only when every finding produced a review entry. */
    readonly reviewComplete?: boolean;
  }>;
}

/**
 * Engines driven by the specialist loop.
 *
 * `ai` is excluded because it is not applicability-gated the way the file-type
 * specialists are: there is no manifest or lockfile whose presence decides
 * whether a model can read the code. It runs on its own path below.
 */
export type AdditionalScanEngine = Exclude<ScanEngine, "gitleaks" | "ai">;

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
  /**
   * Judges that may delete a scanner finding they all agree is a false alarm.
   *
   * Fewer than two, or two of the same family, and review does not run at all:
   * a single reviewer deleting evidence is exactly the failure this guards
   * against. Absent by default, so a worker with no judges behaves as it did
   * before review existed.
   */
  readonly judges?: readonly JudgePort[];
  /**
   * Judges for the scanner-finding council, TRUST-ORDERED, most trusted
   * first: each finding is decided by the two most senior judges that answer.
   * Separate from `judges` because the council may include the scout's own
   * family, which must never judge the scout's findings in the funnel.
   * Absent means the council uses `judges`.
   */
  readonly councilJudges?: readonly JudgePort[];
  /**
   * Pass-1 reader. Absent means the AI engine never runs and every repository
   * reports `unsupported` for it, which is honest: the check exists and did
   * not happen here.
   */
  readonly scout?: ScoutPort;
  /**
   * Repositories per worker run that may be read by a model.
   *
   * The daily model budget is small and shared, so this is a hard stop rather
   * than a target. Repositories past it report `unsupported` rather than
   * silently looking clean.
   */
  readonly aiRepositoryBudget?: number;
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

/**
 * Records why a publication was refused.
 *
 * A silent `catch` here cost hours: a repository that cannot publish keeps its
 * lease, and a worker that will not claim while holding a lease then deadlocks
 * the whole queue with no explanation anywhere. Only the message is emitted,
 * and only when it is one this code raised. Anything else, including anything
 * a scanner or a model could have influenced, is reported as a fixed class.
 */
/**
 * Messages safe to print verbatim, because this code wrote all of them.
 *
 * Anything else is matched against a conservative shape first. A scanner path,
 * a code excerpt or a model's prose would all fail that shape and be reported
 * as UNCLASSIFIED with only a length, which is enough to tell a large echoed
 * body from a short internal string without printing either.
 */
/**
 * A colon is allowed because the message that actually mattered carried one.
 *
 * The worker reaches the ledger over HTTP, so a rejected publication arrives as
 * "control plane rejected request: INVALID_BODY", where the tail is a fixed
 * protocol reason. Without the colon that whole message was withheld as
 * UNCLASSIFIED, which is how a plain contract violation stayed unexplained
 * through a production stall. A scanner path or a code excerpt still fails this
 * shape on its slashes, braces, or newlines.
 */
const SAFE_MESSAGE = /^[A-Za-z0-9 _.,:'-]{1,160}$/;

function reportPublishFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "";
  process.stderr.write(
    `${JSON.stringify({
      event: "publish_refused",
      reason: SAFE_MESSAGE.test(message) ? message : "UNCLASSIFIED",
      length: message.length,
    })}\n`,
  );
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
  readonly #judges: readonly JudgePort[];
  readonly #councilJudges: readonly JudgePort[];
  readonly #scout: ScoutPort | null;
  readonly #aiBroker: SourceBlindBroker | null;
  #aiBudget: number;
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
    this.#judges = options.judges ?? [];
    this.#councilJudges = options.councilJudges ?? this.#judges;
    this.#scout = options.scout ?? null;
    this.#aiBudget = options.aiRepositoryBudget ?? 3;
    // Built once. The broker validates the manifest on construction, so a
    // malformed AI manifest fails at startup rather than mid-scan.
    this.#aiBroker =
      options.scout === undefined
        ? null
        : new SourceBlindBroker("ai", AI_BROKER_MANIFEST);
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
      let scanLocations: readonly FindingLocation[] = [];
      let scanReview: readonly ReviewFinding[] = [];
      let scanReviewComplete = false;
      if (this.#scanDomain !== null) {
        const result = await this.#scanDomain.scan(sourcePath);
        scanLocations = result.locations ?? [];
        scanReview = result.review ?? [];
        scanReviewComplete = result.reviewComplete ?? false;
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
          scanLocations = scanResult.locations;
          scanReview = scanResult.review ?? [];
          scanReviewComplete = scanResult.reviewComplete ?? false;
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
      // The AI engine runs here: after the scanners, because their findings are
      // the lines it must blank, and before cleanup, because this is the last
      // moment the source exists on disk.
      if (this.#scout !== null && this.#aiBroker !== null) {
        if (repository.aiEligible === false) {
          // Discovery awarded this request's deep-read slots to its most
          // recently pushed repositories, and this one lost. Only an explicit
          // false skips: null or absent means the row predates the mark, and
          // those fall through to the old first-claimed-first-read budget.
          coverage.ai = "unsupported";
        } else if (this.#aiBudget <= 0) {
          coverage.ai = "unsupported";
        } else {
          try {
            const reviewed = await runAiEngine({
              sourcePath,
              repositoryId: repository.repositoryId,
              repositoryName: repository.name,
              review: scanReview,
              scout: this.#scout,
              judges: this.#judges,
              tokenBudget: AI_TOKEN_BUDGET,
            });
            // The budget models provider requests, so it is spent only when a
            // request was actually made. A repository of documentation makes
            // none, and burning a slot on it used to cost a repository further
            // down the list its review for nothing.
            if (reviewed.requestsSpent > 0) this.#aiBudget -= 1;
            coverage.ai = reviewed.coverage;
            // A failed engine must always carry a reason. Publication refuses
            // an unattributed failure, and the refusal keeps the lease, which
            // stalls every repository queued behind this one. The reader
            // returns "failed" rather than throwing when a provider is
            // unreachable, so the catch below never saw this case.
            if (reviewed.coverage === "failed") {
              specialistReasons.ai = "SCANNER_INTERNAL";
            }
            if (reviewed.packet !== null && reviewed.packet.groups.length > 0) {
              normalizedByEngine.set("ai", {
                normalized: {
                  packetBytes: new TextEncoder().encode(
                    JSON.stringify(reviewed.packet),
                  ),
                  coverage: reviewed.coverage === "partial" ? "partial" : "complete",
                  reason: null,
                },
                broker: this.#aiBroker,
              });
              scanLocations = [...scanLocations, ...reviewed.locations];
            }
          } catch {
            // A model outage must never fail a scan whose scanners succeeded.
            // The slot is spent either way here: something went wrong far
            // enough in that a request may well have been made.
            this.#aiBudget -= 1;
            coverage.ai = "failed";
            specialistReasons.ai = "SCANNER_INTERNAL";
          }
        }
      } else {
        coverage.ai = "unsupported";
      }
      await advance("normalizing");
      await advance("cleaning");
      sourceCleaned = await this.#removeScratch(jobRoot);
      if (!sourceCleaned) return "cleanup_pending";
      await advance("uploading");
      // Council review runs here: outside the sandbox, which is the only side
      // with a network, and before anything is brokered, so a suppressed
      // finding never becomes a stored finding at all.
      const councilOutcome = await this.#reviewFindings(
        scanReview,
        scanReviewComplete,
      );
      // Per-finding suppression, the primary path. Each rejected finding is
      // subtracted from its rule's exact count before the report's buckets
      // are formed, and its location goes with it, so one false alarm dies
      // while the real finding beside it survives. Falls back to whole-rule
      // suppression when a packet carries no exact counts.
      const gitleaksEntry = normalizedByEngine.get("gitleaks");
      let publishLocations = scanLocations;
      let suppressedRuleIds: ReadonlySet<string> = new Set();
      if (councilOutcome !== null && councilOutcome.rejected.length > 0) {
        const subtracted =
          gitleaksEntry === undefined
            ? null
            : subtractRejectedFindings(
                gitleaksEntry.normalized,
                councilOutcome.rejected,
              );
        if (subtracted !== null && gitleaksEntry !== undefined) {
          normalizedByEngine.set("gitleaks", {
            normalized: subtracted,
            broker: gitleaksEntry.broker,
          });
          publishLocations = withoutRejectedLocations(
            scanLocations,
            councilOutcome.rejected,
          );
        } else if (councilOutcome.complete) {
          // No exact counts. A whole rule may still vanish, but only when
          // every reviewed occurrence of it was rejected and the review was
          // complete, because a bucket cannot honestly shrink by one.
          suppressedRuleIds = new Set(councilOutcome.suppressedRuleIds);
        }
      }
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
          const surviving = accepted.filter(
            (finding) => !suppressedRuleIds.has(finding.rule_id),
          );
          findings.push(...attachLocations(surviving, publishLocations));
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
            // The fallback was the literal "FINDING_LIMIT", whose label reads
            // "this repository has more findings than one report can list".
            // A repository whose AI review came back partial has no failed
            // engine, so that fired and printed a cap explanation over a
            // repository that never hit a cap: an invented rationale on a page
            // whose whole argument is that it does not invent.
            //
            // A real cap does have a reason and the normalizer already
            // produces it, but in the normalized result rather than in
            // specialistReasons, which only carries outright failures. So:
            // the failed engine's class if one failed, else whatever reason an
            // engine actually reported, else none at all. The per-engine entry
            // says the rest, and the row's own label reads "Partly scanned.
            // Some checks finished and at least one did not" without a reason.
            reason:
              failedEngine === undefined
                ? ([...normalizedByEngine.values()]
                    .map((entry) => entry.normalized.reason)
                    .find((reason) => reason !== null && reason !== undefined) ??
                  null)
                : (specialistReasons[failedEngine] ?? null),
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
      } catch (error) {
        reportPublishFailure(error);
        return (await this.#publishFailClosed(lease, coverage, specialistReasons))
          ? "failed"
          : "publish_deferred";
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
      } catch (publishError) {
        reportPublishFailure(publishError);
        return (await this.#publishFailClosed(
          lease,
          coverage,
          specialistReasons,
          reason,
        ))
          ? "failed"
          : "publish_deferred";
      }
    }
  }

  /**
   * Publishes a repository as failed when its real result could not be.
   *
   * A refused publication keeps the lease, and this worker will not claim
   * while it holds one, so a single repository whose result cannot be
   * represented stalls every repository queued behind it. That is exactly what
   * happened in production, and it took deleting the row by hand to clear.
   *
   * The escape is a publication that is certainly representable: every engine
   * that had succeeded is demoted to failed, because its findings are being
   * discarded either way, and the repository is published as failed. That
   * costs this repository its findings, which is a real loss, and it is the
   * smaller one. The alternative loses every other repository in the request
   * as well, and leaves the ledger claiming they are still scanning.
   */
  async #publishFailClosed(
    lease: LeaseRef,
    coverage: Record<
      (typeof SPECIALISTS)[number],
      SpecialistOutcomes[(typeof SPECIALISTS)[number]]
    >,
    specialistReasons: Partial<Record<ScanEngine, FailureClass>>,
    /** The reason the refused publication carried, kept where it still fits. */
    preferredReason?: FailureClass,
  ): Promise<boolean> {
    const failed = { ...coverage };
    for (const engine of SCAN_ENGINES) {
      if (["complete", "partial"].includes(failed[engine])) {
        failed[engine] = "failed";
      }
    }
    // A failed publication has to name something that failed. If nothing did,
    // the secret scan is the one that produced no recorded result, and saying
    // so is more honest than publishing a repository as failed with every
    // check reading clean.
    if (!SCAN_ENGINES.some((engine) => failed[engine] === "failed")) {
      failed.gitleaks = "failed";
    }
    // A failed snapshot or archive guard already explains the whole
    // repository, and the contract refuses per-engine reasons alongside one.
    const baseFailed =
      failed.snapshot === "failed" || failed.archive_guard === "failed";
    const reasons: Partial<Record<ScanEngine, FailureClass>> = {};
    if (!baseFailed) {
      for (const engine of SCAN_ENGINES) {
        if (failed[engine] !== "failed") continue;
        reasons[engine] = specialistReasons[engine] ?? "SCANNER_INTERNAL";
      }
    }
    // The truthful reason survives wherever the contract still allows it. A
    // repository whose download was refused should say so, not report a
    // generic internal fault because the recovery path had nothing better.
    const attributed = baseFailed
      ? preferredReason
      : (SCAN_ENGINES.map((engine) => reasons[engine]).find(
          (reason) => reason !== undefined,
        ) ?? preferredReason);
    try {
      const publication = await this.#store.publish({
        ...lease,
        terminalState: "failed",
        reason: attributed ?? "SCANNER_INTERNAL",
        coverage: failed,
        specialistReasons: reasons,
        findings: [],
        nowMs: this.#now(),
      });
      return publication === "published" || publication === "idempotent";
    } catch (error) {
      reportPublishFailure(error);
      return false;
    }
  }

  /**
   * Asks the council which scanner findings are false alarms.
   *
   * Returns the full outcome, or null when review could not run at all: too
   * few judges, two judges of one family, nothing to review, or any thrown
   * error. Deleting a real finding is far worse than showing a false one, so
   * null means nothing is suppressed anywhere.
   */
  async #reviewFindings(
    review: readonly ReviewFinding[],
    reviewComplete: boolean,
  ): Promise<FindingReviewOutcome | null> {
    const judges = this.#councilJudges;
    const families = new Set(judges.map((judge) => judge.family));
    if (review.length === 0 || judges.length < 2 || families.size !== judges.length) {
      return null;
    }
    try {
      return await reviewScannerFindings(review, judges, reviewComplete);
    } catch {
      return null;
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

/**
 * Attaches published locations to brokered findings.
 *
 * Deliberately applied AFTER `broker.accept()` returns. Locations arrive on
 * their own bounded channel, never inside the packet, so the packet keeps its
 * numbers-only property and the manifest remains the only source of display
 * strings. A finding with no matching location is published without one: a
 * report may omit where something is, it may never invent it.
 */
/**
 * Subtracts council-rejected findings from a packet's exact counts.
 *
 * Returns null whenever the arithmetic cannot be trusted end to end: no exact
 * counts, counts that disagree with the packet's own buckets, a rejected rule
 * outside the manifest, or a subtraction that would go below zero. Null means
 * nothing is subtracted anywhere, because a report that shows a false alarm
 * beats a report whose numbers stopped being real.
 */
function subtractRejectedFindings(
  normalized: NormalizedResult,
  rejected: readonly ReviewFinding[],
): NormalizedResult | null {
  const counts = normalized.counts;
  if (counts === undefined) return null;
  let packet: unknown;
  try {
    packet = JSON.parse(new TextDecoder().decode(normalized.packetBytes));
  } catch {
    return null;
  }
  const parsed = brokerResultPacketSchema.safeParse(packet);
  if (!parsed.success) return null;
  const byToken = new Map(counts.map((entry) => [entry.token, entry.count]));
  // The counts must describe exactly the packet they arrived beside.
  if (
    parsed.data.groups.length !== byToken.size ||
    parsed.data.groups.some((group) => {
      const count = byToken.get(group.token);
      return count === undefined || bucketForCount(count) !== group.bucket;
    })
  ) {
    return null;
  }
  const tally = new Map<number, number>();
  for (const finding of rejected) {
    if (finding.engine !== "gitleaks") continue;
    const token = gitleaksRuleToken(finding.ruleId);
    if (token === null) return null;
    tally.set(token, (tally.get(token) ?? 0) + 1);
  }
  if (tally.size === 0) return null;
  const remaining: { token: number; count: number }[] = [];
  for (const [token, count] of byToken) {
    const removed = tally.get(token) ?? 0;
    if (removed > count) return null;
    if (count - removed > 0) remaining.push({ token, count: count - removed });
  }
  const rebuilt = {
    schemaVersion: 1 as const,
    groups: remaining
      .toSorted((left, right) => left.token - right.token)
      .map((entry) => ({ token: entry.token, bucket: bucketForCount(entry.count) })),
  };
  if (!brokerResultPacketSchema.safeParse(rebuilt).success) return null;
  return {
    packetBytes: new TextEncoder().encode(JSON.stringify(rebuilt)),
    coverage: normalized.coverage,
    reason: normalized.reason,
    counts: remaining.toSorted((left, right) => left.token - right.token),
  };
}

/**
 * Drops each rejected finding's location, one occurrence per rejection.
 *
 * Matching is by rule, path and line. Removal is tallied rather than blanket
 * so that two findings sharing a line lose exactly as many entries as the
 * council rejected, and only gitleaks entries are ever touched.
 */
function withoutRejectedLocations(
  locations: readonly FindingLocation[],
  rejected: readonly ReviewFinding[],
): readonly FindingLocation[] {
  const key = (ruleId: string, where: string, line: number): string =>
    `${ruleId}\u0000${where}\u0000${String(line)}`;
  const tally = new Map<string, number>();
  for (const finding of rejected) {
    if (finding.engine !== "gitleaks") continue;
    const found = key(finding.ruleId, finding.path, finding.startLine);
    tally.set(found, (tally.get(found) ?? 0) + 1);
  }
  return locations.filter((entry) => {
    if (entry.engine !== "gitleaks") return true;
    const found = key(entry.ruleId, entry.path, entry.startLine);
    const left = tally.get(found) ?? 0;
    if (left === 0) return true;
    tally.set(found, left - 1);
    return false;
  });
}

function attachLocations(
  findings: readonly BrokerDerivedFinding[],
  locations: readonly FindingLocation[],
): readonly BrokerDerivedFinding[] {
  if (locations.length === 0) return findings;
  return findings.map((finding) => {
    const matched = locations
      .filter(
        (entry) =>
          entry.engine === finding.engine && entry.ruleId === finding.rule_id,
      )
      .slice(0, MAX_LOCATIONS_PER_FINDING)
      .map((entry) => ({ path: entry.path, startLine: entry.startLine }));
    return matched.length === 0 ? finding : { ...finding, locations: matched };
  });
}
