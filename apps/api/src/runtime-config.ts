import path from "node:path";

export interface RuntimeConfiguration {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly databasePath: string;
  readonly scratchPath: string;
  readonly githubToken: string | undefined;
  readonly gitleaksBinary: string;
  readonly gitleaksSha256: string;
  readonly allowedRequestedLogins: ReadonlySet<string>;
  readonly allowedGithubAccountIds: ReadonlySet<number>;
  readonly operatorMode: boolean;
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function csv(value: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error("invalid comma-separated runtime setting");
  }
  return entries;
}

export function parseRuntimeConfiguration(
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): RuntimeConfiguration {
  const host = environment["HOST"] ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("private slice requires loopback HOST");
  }
  const port = Number(environment["PORT"] ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("invalid PORT");
  }
  const accountIds = csv(required(environment, "PRIVATE_SLICE_ACCOUNT_IDS")).map(
    (value) => Number(value),
  );
  if (
    accountIds.some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new Error("invalid PRIVATE_SLICE_ACCOUNT_IDS");
  }
  const gitleaksSha256 = required(environment, "GITLEAKS_SHA256");
  if (!/^[a-f0-9]{64}$/.test(gitleaksSha256)) {
    throw new Error("invalid GITLEAKS_SHA256");
  }
  const dataRoot = path.resolve(cwd, ".data");
  return {
    host,
    port,
    databasePath: path.resolve(
      environment["DATABASE_PATH"] ?? path.join(dataRoot, "store.sqlite"),
    ),
    scratchPath: path.resolve(
      environment["SCRATCH_PATH"] ?? path.join(dataRoot, "scratch"),
    ),
    githubToken:
      environment["GITHUB_TOKEN"] === undefined ||
      environment["GITHUB_TOKEN"] === ""
        ? undefined
        : environment["GITHUB_TOKEN"],
    gitleaksBinary: path.resolve(required(environment, "GITLEAKS_BINARY")),
    gitleaksSha256,
    allowedRequestedLogins: new Set(
      csv(environment["PRIVATE_SLICE_LOGINS"] ?? "ri7in").map((value) =>
        value.toLowerCase(),
      ),
    ),
    allowedGithubAccountIds: new Set(accountIds),
    operatorMode: environment["OPERATOR_MODE"] === "true",
  };
}
