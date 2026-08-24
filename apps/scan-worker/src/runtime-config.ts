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
    /** Preferred reader first, stable fallback last. */
    readonly models: readonly string[];
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
): null | { readonly apiKey: string; readonly models: readonly string[] } {
  // On wherever a key exists, off with one variable.
  //
  // It was off while the stall that followed it was unexplained. The cause was
  // a plain contract violation: a reader that could not reach its provider set
  // the AI engine to failed without attaching a reason, the ledger refuses an
  // unattributed failure, and a refused publication keeps its lease, which this
  // worker will not claim past. Both halves are fixed, so the default is back
  // to on.
  if (environment["AI_REVIEW_ENABLED"] === "false") return null;
  const apiKey = environment["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") return null;
  const preferred = environment["OPENROUTER_SCOUT_MODEL"];
  // ox-alpha reads first: it is the sharper reader and cites the offending
  // line rather than the surrounding block. It is also an unbranded preview
  // that can be withdrawn without notice, so named, stable models sit behind
  // it. Losing the preview then costs a little precision instead of costing
  // the entire AI pass silently.
  //
  // The chain deepened on 2026-08-24 after a live scan lost two of its three
  // reads to free-tier congestion: one link behind the preview was not
  // enough. All four ids verified against OpenRouter's live model list that
  // day. The two nemotron-adjacent links hold a million tokens; glm-5.2 and
  // nemotron-super hold 256K, which still carries most repositories whole.
  // The free nemotron endpoints do not honour response_format, which is
  // tolerable because the response parser already digs the first balanced
  // JSON object out of prose.
  const chain = [
    preferred ?? "stealth/ox-alpha",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "z-ai/glm-5.2:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
  ];
  return {
    apiKey,
    models: [...new Set(chain)],
  };
}

/**
 * Builds the judge panel from whichever provider keys are present.
 *
 * Gated on the same switch as the reader, because it was not and that made the
 * switch a lie: the judges also review secret-scanner findings, and that path
 * ships a window of up to 120 lines of real source to every judge. Turning the
 * reader off while excerpts kept going to the providers is not "off".
 */
function judgePanel(
  environment: NodeJS.ProcessEnv,
): readonly {
  readonly apiKey: string;
  readonly model: string;
  readonly family: string;
  readonly endpoint: string;
}[] {
  if (environment["AI_REVIEW_ENABLED"] === "false") return [];
  // TRUST-ORDERED, strongest first, on operator instruction: the council
  // decides each finding by the two most senior judges that answer, so this
  // order is policy rather than style. ox has found real bugs the others
  // missed; Gemini is the stronger of the stable pair. gpt-oss stays as the
  // quorum partner for the day the preview model disappears.
  //
  // Verified against the live providers on 2026-08-23: each of the stable two
  // returned the correct verdict on two genuine secrets and two documentation
  // placeholders. Free model ids churn fast, hence the env overrides.
  const candidates = [
    {
      keyName: "OPENROUTER_API_KEY",
      family: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model: environment["OPENROUTER_JUDGE_MODEL"] ?? "stealth/ox-alpha",
    },
    {
      keyName: "GEMINI_API_KEY",
      family: "google",
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: environment["GEMINI_JUDGE_MODEL"] ?? "gemini-flash-lite-latest",
    },
    {
      keyName: "GROQ_API_KEY",
      family: "groq",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      model: environment["GROQ_JUDGE_MODEL"] ?? "openai/gpt-oss-120b",
    },
    // Last in trust on purpose. The only Qwen with a free API today is this
    // 27B preview on Groq (verified 2026-08-24; OpenRouter has no free Qwen
    // or DeepSeek at all, SambaNova's free DeepSeek allows 20 requests a
    // day). It shares Groq's quota with gpt-oss and its 8K tokens-per-minute
    // cap will throttle on big excerpts, so it is a fourth opinion that adds
    // depth when a senior judge is unreachable, never the deciding voice
    // while two seniors answered. The family label is the model lineage:
    // distinctness of failure modes comes from who trained it, not from
    // which datacentre serves it.
    {
      keyName: "GROQ_API_KEY",
      family: "qwen",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      model: environment["QWEN_JUDGE_MODEL"] ?? "qwen/qwen3.6-27b",
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
