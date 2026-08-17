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
  };
}
