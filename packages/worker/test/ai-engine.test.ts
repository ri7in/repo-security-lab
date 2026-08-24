import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JudgePort, ScoutPort } from "@app/ai";
import type { AiScoutFlag, ReviewFinding } from "@app/contracts";
import { runAiEngine } from "@app/worker";

/**
 * The AI engine, with the model replaced by a fake.
 *
 * The interesting behaviour is not whether a model finds bugs, which no test
 * can pin down, but everything around it: that a secret is blanked before the
 * reader sees a file, that an outage degrades rather than fails a scan, and
 * that a class outside the closed vocabulary cannot reach a report.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const SECRET = ["ghp", "_", "K3y9M2n8B4v6C1x7Z5a3S0d8F6g4H2j0L9k7"].join("");

/**
 * A source tree shaped the way a GitHub tarball actually unpacks.
 *
 * Every fixture used to be flat, which is why a redaction lookup that could
 * never match in production passed here for weeks: the two sides only disagree
 * once there is a wrapper directory, and there always is one.
 */
async function sourceTree(
  files: Record<string, string>,
  wrapper = "owner-fixture-6feceed",
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-ai-"));
  temporaryDirectories.push(root);
  const wrapped = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [
      wrapper === "" ? name : `${wrapper}/${name}`,
      content,
    ]),
  );
  files = wrapped;
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

/** A scout that reports whatever flags the test hands it, echoing file tokens. */
function scoutReturning(
  build: (packText: string) => readonly AiScoutFlag[],
): ScoutPort & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    analyze: (request) => {
      seen.push(request.userPrompt);
      return Promise.resolve({ flags: [...build(request.userPrompt)] });
    },
  };
}

function judge(family: string, verdict: string): JudgePort {
  return {
    family,
    review: () => Promise.resolve({ verdict, reason: "fixture" }),
  } as unknown as JudgePort;
}

const JUDGES = [judge("alpha", "real"), judge("beta", "real")];

function flag(overrides: Partial<AiScoutFlag> = {}): AiScoutFlag {
  return {
    fileToken: 0,
    lineStart: 1,
    lineEnd: 1,
    evidenceQuote: "const query = `SELECT * FROM users WHERE id = ${id}`",
    cwe: "CWE-89",
    impact: "data-disclosure",
    rationale: "interpolated into SQL",
    confidence: "high",
    ...overrides,
  };
}

const VULNERABLE = 'const query = `SELECT * FROM users WHERE id = ${id}`\n';

describe("the AI engine", () => {
  it("brokers a confirmed flag as a numeric token, never as prose", async () => {
    const sourcePath = await sourceTree({ "src/db.ts": VULNERABLE });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() => [flag()]),
      judges: JUDGES,
      tokenBudget: 50_000,
    });

    expect(result.coverage).toBe("complete");
    // CWE-89 is the fourth entry in the closed vocabulary.
    expect(result.packet?.groups).toEqual([{ token: 4, bucket: 0 }]);
    expect(result.locations[0]?.engine).toBe("ai");
    expect(result.locations[0]?.path).toBe("src/db.ts");
    // Nothing the model wrote appears anywhere in the result.
    expect(JSON.stringify(result)).not.toContain("interpolated into SQL");
  }, 30_000);

  it("blanks a detected secret before the reader sees the file", async () => {
    const sourcePath = await sourceTree({
      "src/config.ts": `const token = "${SECRET}";\n${VULNERABLE}`,
    });
    const review: ReviewFinding[] = [
      {
        engine: "gitleaks",
        ruleId: "github-pat",
        path: "src/config.ts",
        startLine: 1,
        entropy: 4.5,
        fileLineCount: 1,
        valueLength: 40,
        valueHints: [],
        contextStartLine: 1,
        contextLines: [],
      },
    ];
    const scout = scoutReturning(() => []);
    await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review,
      scout,
      judges: JUDGES,
      tokenBudget: 50_000,
    });

    // The pass hunting injection bugs has no use for a credential, and must
    // not be handed one in passing.
    expect(scout.seen.join("\n")).not.toContain(SECRET);
  }, 30_000);

  it("blanks a secret in a real GitHub tarball layout, not just a flat one", async () => {
    // GitHub wraps everything in `owner-repo-sha/`. The secret scanner strips
    // that before reporting a path; the reader did not, so the two sides of
    // the redaction lookup used different strings and it silently matched
    // nothing. Every existing test used a flat fixture and never saw it.
    const sourcePath = await sourceTree({
      "src/config.ts": `const token = "${SECRET}";\n${VULNERABLE}`,
    });
    const review: ReviewFinding[] = [
      {
        engine: "gitleaks",
        ruleId: "github-pat",
        // Repository-relative, which is what the scanner publishes.
        path: "src/config.ts",
        startLine: 1,
        entropy: 4.5,
        fileLineCount: 1,
        valueLength: 40,
        valueHints: [],
        contextStartLine: 1,
        contextLines: [],
      },
    ];
    const scout = scoutReturning(() => []);
    await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review,
      scout,
      judges: JUDGES,
      tokenBudget: 50_000,
    });
    expect(scout.seen.join("\n")).not.toContain(SECRET);
  }, 30_000);

  it("reports a location the reader can actually open", async () => {
    // The first AI finding to reach a live report pointed at
    // `ri7in-W-Tech-6feceed/php/Job Insert.php`, a path that exists nowhere
    // in the repository.
    const sourcePath = await sourceTree({
      "src/db.ts": VULNERABLE,
    });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() => [flag()]),
      judges: JUDGES,
      tokenBudget: 50_000,
    });
    expect(result.locations[0]?.path).toBe("src/db.ts");
  }, 30_000);

  it("drops a class outside the closed vocabulary", async () => {
    const sourcePath = await sourceTree({ "src/db.ts": VULNERABLE });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() => [
        flag({ cwe: "CWE-1337" as AiScoutFlag["cwe"] }),
      ]),
      judges: JUDGES,
      tokenBudget: 50_000,
    });
    expect(result.packet?.groups ?? []).toEqual([]);
  }, 30_000);

  it("does not call a review partial because a README was not code", async () => {
    // The reader reads source, so a markdown file being left out is the design
    // working. Counting it turned every reviewed repository into a partial one
    // and the label stopped meaning anything.
    const sourcePath = await sourceTree({
      "src/db.ts": VULNERABLE,
      "README.md": "# docs\n",
      "package-lock.json": "{}\n",
    });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() => []),
      judges: JUDGES,
      tokenBudget: 50_000,
    });
    expect(result.coverage).toBe("complete");
  }, 30_000);

  it("does call a review partial when code did not fit", async () => {
    // A file past the token budget is code the reader would have read.
    const big = `${VULNERABLE}${"// filler filler filler\n".repeat(500)}`;
    const sourcePath = await sourceTree({
      "src/one.ts": big,
      "src/two.ts": big,
      "src/three.ts": big,
    });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() => []),
      judges: JUDGES,
      // Room for one of the three, so the other two are code the reader
      // would have read and did not.
      tokenBudget: 5_000,
    });
    expect(result.coverage).toBe("partial");
  }, 30_000);

  it("reports nothing to read as clean, not as failure", async () => {
    const sourcePath = await sourceTree({ "README.md": "# docs only\n" });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() => []),
      judges: JUDGES,
      tokenBudget: 50_000,
    });
    // A repository with no source is a clean result for a code reader.
    expect(result.coverage).toBe("not_applicable");
    expect(result.packet).toBeNull();
  }, 30_000);

  it("degrades to failed when the reader is unreachable", async () => {
    const sourcePath = await sourceTree({ "src/db.ts": VULNERABLE });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: { analyze: () => Promise.reject(new Error("provider down")) },
      judges: JUDGES,
      tokenBudget: 50_000,
    });
    // Failed, never "complete with no findings", which would read as clean.
    expect(result.coverage).toBe("failed");
    expect(result.packet).toBeNull();
  }, 30_000);

  it("reports a capped review as partial, never as a finished one", async () => {
    // Twenty is the judge cap. Twenty five grounded flags means five were
    // never judged, and a review that did not finish must not be published as
    // one that did.
    const lines = Array.from({ length: 25 }, () => VULNERABLE.trim()).join("\n");
    const sourcePath = await sourceTree({ "src/db.ts": `${lines}\n` });
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() =>
        Array.from({ length: 25 }, (_, index) =>
          flag({ lineStart: index + 1, lineEnd: index + 1 }),
        ),
      ),
      judges: JUDGES,
      tokenBudget: 200_000,
    });
    expect(result.coverage).toBe("partial");
  }, 30_000);

  it("reports a review the council could not finish as partial", async () => {
    // Fewer than two usable verdicts is no council at all for that flag.
    const sourcePath = await sourceTree({ "src/db.ts": VULNERABLE });
    const failing: JudgePort = {
      family: "gamma",
      review: () => Promise.reject(new Error("provider down")),
    };
    const result = await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout: scoutReturning(() => [flag()]),
      judges: [judge("alpha", "real"), failing],
      tokenBudget: 50_000,
    });
    expect(result.coverage).toBe("partial");
    expect(result.packet?.groups ?? []).toEqual([]);
  }, 30_000);

  it("keeps reading when a directory cannot be listed", async () => {
    // An unreadable directory is skipped, never fatal: one bad permission bit
    // must not cost a repository its entire code review.
    const sourcePath = await sourceTree({
      "src/app.ts": VULNERABLE,
      "locked/inner.ts": "export const b = 2;\n",
    });
    const locked = path.join(sourcePath, "owner-fixture-6feceed", "locked");
    await chmod(locked, 0o000);
    const scout = scoutReturning(() => []);
    try {
      const result = await runAiEngine({
        sourcePath,
        repositoryId: 7,
        repositoryName: "fixture",
        review: [],
        scout,
        judges: JUDGES,
        tokenBudget: 50_000,
      });
      expect(result.coverage).toBe("complete");
      expect(scout.seen.join("\n")).toContain("app.ts");
    } finally {
      await chmod(locked, 0o700);
    }
  }, 30_000);

  it("does not walk into dependency or build directories", async () => {
    const sourcePath = await sourceTree({
      "src/app.ts": "export const a = 1;\n",
      "node_modules/left-pad/index.js": VULNERABLE,
      "dist/bundle.js": VULNERABLE,
    });
    const scout = scoutReturning(() => []);
    await runAiEngine({
      sourcePath,
      repositoryId: 7,
      repositoryName: "fixture",
      review: [],
      scout,
      judges: JUDGES,
      tokenBudget: 50_000,
    });
    const packed = scout.seen.join("\n");
    // Someone else's dependency is not the owner's bug to fix, and build
    // output is a copy of source that is already being read.
    expect(packed).not.toContain("left-pad");
    expect(packed).not.toContain("bundle.js");
    expect(packed).toContain("app.ts");
  }, 30_000);
});
