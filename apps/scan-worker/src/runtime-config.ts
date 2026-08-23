import path from "node:path";
import { opaqueIdSchema, type OpaqueId } from "@app/contracts";

export interface ScanWorkerConfiguration {
  readonly controlPlaneUrl: string;
  readonly workerId: OpaqueId;
  readonly keyGeneration: number;
  readonly workerSecret: string;
  readonly scratchPath: string;
  readonly gitleaksBinary: string;
  readonly gitleaksSha256: string;
  readonly githubToken: string | undefined;
  readonly allowedGithubAccountIds: ReadonlySet<number> | null;
  readonly pollIntervalMs: number;
  readonly maxJobsPerTick: number;
  readonly runOnce: boolean;
  readonly zizmor: null | {
    readonly binaryPath: string;
    readonly sha256: string;
  };
  /**
   * Judges permitted to delete a scanner finding all of them reject.
   *
   * Empty or single-entry means review never runs, which is the safe default:
   * one reviewer deleting evidence is the failure this is built to avoid.
   * Model ids are overridable because free-tier model names churn, and a
   * missing model is better than a silently wrong one.
   */
  readonly judges: readonly {
    readonly apiKey: string;
    readonly model: string;
    readonly family: string;
    readonly endpoint: string;
  }[];
  /**
   * Pass-1 reader. Absent means the AI engine never runs.
   *
   * Deliberately a different provider from every judge. A model that both
   * raises a finding and votes on it is one opinion wearing two hats, and the
   * council's whole value is that it is not the thing being checked.
   */
  readonly scout: null | {
    readonly apiKey: string;
    readonly model: string;
  };
  readonly isolation: null | {
    readonly bubblewrapPath: string;
    readonly nodePath: string;
    readonly applicationBundlePath: string;
    readonly runtimeLibraryPaths: readonly string[];
  };
}

/** The pass-1 reader, or null when no key is configured. */
function scoutConfig(
  environment: NodeJS.ProcessEnv,
): null | { readonly apiKey: string; readonly model: string } {
  const apiKey = environment["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") return null;
  return {
    apiKey,
    // A million-token context, which is what lets one request hold a whole
    // repository rather than a sampled slice of it.
    model:
      environment["OPENROUTER_SCOUT_MODEL"] ??
      "nvidia/nemotron-3-ultra-550b-a55b:free",
  };
}

/** Builds the judge panel from whichever provider keys are present. */
function judgePanel(
  environment: NodeJS.ProcessEnv,
): readonly {
  readonly apiKey: string;
  readonly model: string;
  readonly family: string;
  readonly endpoint: string;
}[] {
  // Verified against the live providers on 2026-08-23: each of these returned
  // the correct verdict on two genuine secrets and two documentation
  // placeholders. Free model ids churn fast, hence the env overrides.
  const candidates = [
    {
      keyName: "GROQ_API_KEY",
      family: "groq",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      model: environment["GROQ_JUDGE_MODEL"] ?? "openai/gpt-oss-120b",
    },
    {
      keyName: "GEMINI_API_KEY",
      family: "google",
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: environment["GEMINI_JUDGE_MODEL"] ?? "gemini-flash-lite-latest",
    },
  ];
  const panel = candidates.flatMap((candidate) => {
    const apiKey = environment[candidate.keyName];
    return apiKey === undefined || apiKey.trim() === ""
      ? []
      : [
          {
            apiKey,
            model: candidate.model,
            family: candidate.family,
            endpoint: candidate.endpoint,
          },
        ];
  });
  // One judge cannot disagree with itself, so a panel of one is no panel.
  return panel.length >= 2 ? panel : [];
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (value === undefined || value === "") throw new Error(`${key} is required`);
  return value;
}

function positiveInteger(value: string, key: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${key} is invalid`);
  }
  return parsed;
}

function accountScope(environment: NodeJS.ProcessEnv): ReadonlySet<number> | null {
  if (environment["PUBLIC_WORKER"] === "true") return null;
  const values = required(environment, "PRIVATE_SLICE_ACCOUNT_IDS")
    .split(",")
    .map((value) => Number(value.trim()));
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("PRIVATE_SLICE_ACCOUNT_IDS is invalid");
  }
  return new Set(values);
}

export function parseScanWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): ScanWorkerConfiguration {
  const workerId = required(environment, "WORKER_ID");
  if (!opaqueIdSchema.safeParse(workerId).success) {
    throw new Error("WORKER_ID is invalid");
  }
  const keyGeneration = positiveInteger(
    required(environment, "WORKER_KEY_GENERATION"),
    "WORKER_KEY_GENERATION",
    1_000_000,
  );
  const workerSecret = required(environment, "WORKER_SECRET");
  if (workerSecret.length < 32 || workerSecret.length > 256) {
    throw new Error("WORKER_SECRET is invalid");
  }
  const scratchPath = path.resolve(
    environment["SCRATCH_PATH"] ?? path.join(cwd, ".data", "worker-scratch"),
  );
  const gitleaksBinary = path.resolve(required(environment, "GITLEAKS_BINARY"));
  const gitleaksSha256 = required(environment, "GITLEAKS_SHA256");
  if (
    scratchPath === path.parse(scratchPath).root ||
    gitleaksBinary === path.parse(gitleaksBinary).root ||
    !/^[a-f0-9]{64}$/.test(gitleaksSha256)
  ) {
    throw new Error("worker filesystem configuration is invalid");
  }
  const publicWorker = environment["PUBLIC_WORKER"] === "true";
  const isolationMode = environment["SCAN_ISOLATION_MODE"] ?? "inline";
  if (publicWorker && isolationMode !== "bubblewrap") {
    throw new Error("public worker requires bubblewrap isolation");
  }
  if (!publicWorker && !["inline", "bubblewrap"].includes(isolationMode)) {
    throw new Error("SCAN_ISOLATION_MODE is invalid");
  }
  let isolation: ScanWorkerConfiguration["isolation"] = null;
  if (isolationMode === "bubblewrap") {
    const runtimeLibraryPaths = required(
      environment,
      "SCAN_RUNTIME_LIBRARY_PATHS",
    )
      .split(",")
      .map((entry) => path.resolve(entry.trim()))
      .filter((entry) => entry !== "");
    if (
      runtimeLibraryPaths.length < 1 ||
      runtimeLibraryPaths.some((entry) => entry === path.parse(entry).root)
    ) {
      throw new Error("SCAN_RUNTIME_LIBRARY_PATHS is invalid");
    }
    isolation = {
      bubblewrapPath: path.resolve(required(environment, "BUBBLEWRAP_BINARY")),
      nodePath: path.resolve(environment["SCAN_NODE_BINARY"] ?? process.execPath),
      applicationBundlePath: path.resolve(
        required(environment, "SCAN_DOMAIN_BUNDLE"),
      ),
      runtimeLibraryPaths,
    };
  }
  const zizmorEnabled = environment["ZIZMOR_ENABLED"] === "true";
  const hasZizmorValues =
    environment["ZIZMOR_BINARY"] !== undefined ||
    environment["ZIZMOR_SHA256"] !== undefined;
  if (!zizmorEnabled && hasZizmorValues) {
    throw new Error("disabled zizmor configuration is invalid");
  }
  if (zizmorEnabled && isolationMode !== "bubblewrap") {
    throw new Error("zizmor requires bubblewrap isolation");
  }
  const zizmor = zizmorEnabled
    ? {
        binaryPath: path.resolve(required(environment, "ZIZMOR_BINARY")),
        sha256: required(environment, "ZIZMOR_SHA256"),
      }
    : null;
  if (zizmor !== null && !/^[a-f0-9]{64}$/u.test(zizmor.sha256)) {
    throw new Error("ZIZMOR_SHA256 is invalid");
  }
  return {
    controlPlaneUrl: required(environment, "CONTROL_PLANE_URL"),
    workerId,
    keyGeneration,
    workerSecret,
    scratchPath,
    gitleaksBinary,
    gitleaksSha256,
    githubToken:
      environment["GITHUB_TOKEN"] === undefined ||
      environment["GITHUB_TOKEN"] === ""
        ? undefined
        : environment["GITHUB_TOKEN"],
    allowedGithubAccountIds: accountScope(environment),
    judges: judgePanel(environment),
    scout: scoutConfig(environment),
    pollIntervalMs: positiveInteger(
      environment["POLL_INTERVAL_MS"] ?? "2000",
      "POLL_INTERVAL_MS",
      60_000,
    ),
    maxJobsPerTick: positiveInteger(
      environment["MAX_JOBS_PER_TICK"] ?? "5",
      "MAX_JOBS_PER_TICK",
      50,
    ),
    runOnce: environment["RUN_ONCE"] === "true",
    zizmor,
    isolation,
  };
}
