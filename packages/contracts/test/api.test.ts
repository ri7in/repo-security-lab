import { describe, expect, it } from "vitest";
import {
  REPOSITORY_STATES,
  SPECIALISTS,
  SPECIALIST_PROGRESS_STATES,
  apiErrorSchema,
  createScanRequestBodySchema,
  githubLoginSchema,
  githubRepoNameSchema,
  publicFindingPageSchema,
  publicFindingSchema,
  repositoryPageSchema,
  repositoryRowSchema,
  scanRequestAcceptedSchema,
  scanRequestSummarySchema,
  type CoverageTotals,
  type RepositoryCoverage,
  type RepositoryStateTotals,
} from "@app/contracts";

function zeroRepositoryTotals(): RepositoryStateTotals {
  return Object.fromEntries(
    REPOSITORY_STATES.map((state) => [state, 0]),
  ) as RepositoryStateTotals;
}

function zeroCoverageTotals(): CoverageTotals {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [
      specialist,
      Object.fromEntries(
        SPECIALIST_PROGRESS_STATES.map((state) => [state, 0]),
      ),
    ]),
  ) as CoverageTotals;
}

function waitingCoverage(): RepositoryCoverage {
  return Object.fromEntries(
    SPECIALISTS.map((specialist) => [specialist, "waiting"]),
  ) as RepositoryCoverage;
}

const validSummary = {
  schemaVersion: 1,
  requestId: "req_0000000001",
  username: "ri7in",
  state: "scanning",
  repositoryTotals: zeroRepositoryTotals(),
  coverageTotals: zeroCoverageTotals(),
  aiLane: "ai_not_run",
  retryAfterSeconds: 5,
  updatedAt: "2026-08-16T00:00:00.000Z",
} as const;

const validRow = {
  repositoryId: 42,
  name: "myslt-alerts",
  state: "waiting",
  coverage: waitingCoverage(),
  aiLane: "ai_not_run",
} as const;

describe("github identifier grammars", () => {
  it("accepts real logins and rejects hostile ones", () => {
    for (const login of ["ri7in", "a", "a-b-c", "A1", "x".repeat(39)]) {
      expect(githubLoginSchema.safeParse(login).success).toBe(true);
    }
    for (const bad of [
      "",
      "-leading",
      "trailing-",
      "double--hyphen",
      "x".repeat(40),
      "user name",
      "user/../../etc",
      "user\n",
    ]) {
      expect(githubLoginSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("bounds repository names to the GitHub grammar", () => {
    for (const name of ["myslt-alerts", "a.b_c-d", "x".repeat(100)]) {
      expect(githubRepoNameSchema.safeParse(name).success).toBe(true);
    }
    for (const bad of ["", "x".repeat(101), "has space", "path/inject", "a\u0000b"]) {
      expect(githubRepoNameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("scan request DTOs", () => {
  it("accepts a valid create body and rejects extra fields", () => {
    expect(
      createScanRequestBodySchema.safeParse({ username: "ri7in" }).success,
    ).toBe(true);
    expect(
      createScanRequestBodySchema.safeParse({
        username: "ri7in",
        token: "ghp_abcdef",
      }).success,
    ).toBe(false);
    expect(
      createScanRequestBodySchema.parse({
        username: "ri7in",
        email: " Person@Example.COM ",
      }).email,
    ).toBe("person@example.com");
    expect(
      createScanRequestBodySchema.safeParse({
        username: "ri7in",
        email: "not-an-email",
      }).success,
    ).toBe(false);
  });

  it("keeps error responses fixed and non-echoing", () => {
    expect(apiErrorSchema.safeParse({ reason: "PRIVATE_SLICE_SCOPE" }).success).toBe(
      true,
    );
    expect(
      apiErrorSchema.safeParse({ reason: "user notfound: ../../etc" }).success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({
        reason: "PRIVATE_SLICE_SCOPE",
        message: "free text",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid accepted response", () => {
    expect(
      scanRequestAcceptedSchema.safeParse({
        requestId: "req_0000000001",
        notification: "not_requested",
      })
        .success,
    ).toBe(true);
  });
});

describe("scan request summary", () => {
  it("accepts a valid exhaustive summary", () => {
    expect(scanRequestSummarySchema.safeParse(validSummary).success).toBe(true);
  });

  it("requires exhaustive totals for every state and specialist", () => {
    const incompleteTotals: Record<string, number> = {
      ...zeroRepositoryTotals(),
    };
    delete incompleteTotals["discovered"];
    expect(
      scanRequestSummarySchema.safeParse({
        ...validSummary,
        repositoryTotals: incompleteTotals,
      }).success,
    ).toBe(false);
  });

  it("cannot express finding data or free-form fields", () => {
    for (const hostile of [
      { ...validSummary, findings: [] },
      { ...validSummary, secretCount: 3 },
      { ...validSummary, message: "scan going well" },
    ]) {
      expect(scanRequestSummarySchema.safeParse(hostile).success).toBe(false);
    }
  });
});

describe("repository ledger rows", () => {
  it("accepts a valid row with an exhaustive coverage map", () => {
    expect(repositoryRowSchema.safeParse(validRow).success).toBe(true);
  });

  it("accepts a fixed failure reason and rejects free-form reasons", () => {
    expect(
      repositoryRowSchema.safeParse({
        ...validRow,
        state: "failed",
        reason: "PRIVATE_SLICE_SCOPE",
      }).success,
    ).toBe(true);
    expect(
      repositoryRowSchema.safeParse({
        ...validRow,
        state: "failed",
        reason: "gitleaks crashed in /tmp/scan-1234",
      }).success,
    ).toBe(false);
  });

  it("accepts only closed per-engine failure attribution", () => {
    expect(
      repositoryRowSchema.safeParse({
        ...validRow,
        specialistReasons: { osv: "SCANNER_TIMEOUT" },
      }).success,
    ).toBe(true);
    for (const specialistReasons of [
      { osv: "scanner printed /tmp/source" },
      { snapshot: "SCANNER_TIMEOUT" },
      { invented: "SCANNER_TIMEOUT" },
    ]) {
      expect(
        repositoryRowSchema.safeParse({ ...validRow, specialistReasons }).success,
      ).toBe(false);
    }
  });

  it("cannot express findings, paths, or snippets", () => {
    for (const hostile of [
      { ...validRow, findings: [{ rule: "x" }] },
      { ...validRow, path: "src/index.ts" },
      { ...validRow, snippet: "const k = 'sk-live'" },
      { ...validRow, name: "evil name with spaces and 'quotes'" },
    ]) {
      expect(repositoryRowSchema.safeParse(hostile).success).toBe(false);
    }
  });

  it("bounds pages and validates cursors as opaque ids", () => {
    expect(
      repositoryPageSchema.safeParse({
        schemaVersion: 1,
        requestId: "req_0000000001",
        repositories: [validRow],
        nextCursor: "cur_0000000002",
      }).success,
    ).toBe(true);
    expect(
      repositoryPageSchema.safeParse({
        schemaVersion: 1,
        requestId: "req_0000000001",
        repositories: [validRow],
        nextCursor: "not a cursor / with / slashes",
      }).success,
    ).toBe(false);
  });
});

describe("public source-blind findings", () => {
  const publicFinding = {
    schema_version: 1,
    repository_id: 42,
    commit_sha: "a".repeat(40),
    engine: "gitleaks",
    rule_id: "github-pat",
    category: "secret",
    severity: "high",
    confidence: "high",
    occurrence_bucket: "one",
    remediation_key: "rotate-secret",
  } as const;

  it("accepts only the public broker-derived subset", () => {
    expect(publicFindingSchema.safeParse(publicFinding).success).toBe(true);
    expect(
      publicFindingPageSchema.safeParse({
        schemaVersion: 1,
        findings: [publicFinding],
      }).success,
    ).toBe(true);
  });

  it("cannot express internal ids or source-derived details", () => {
    for (const extra of [
      { finding_id: "fnd_0000000001" },
      { request_id: "req_0000000001" },
      { owner_detail_ref: "chunk_000001" },
      { path: "src/index.ts" },
      { snippet: "const token = 'secret'" },
      { match: "secret-value" },
    ]) {
      expect(
        publicFindingSchema.safeParse({ ...publicFinding, ...extra }).success,
      ).toBe(false);
    }
  });
});
