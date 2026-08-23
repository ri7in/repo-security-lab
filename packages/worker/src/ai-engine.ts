import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DetectionFunnel,
  buildScoutPack,
  type JudgePort,
  type ScoutPort,
} from "@app/ai";
import { AI_BROKER_MANIFEST, aiCweToken } from "@app/scanners";
import type {
  FindingLocation,
  ReviewFinding,
  SpecialistCoverageOutcome,
} from "@app/contracts";

/**
 * The AI engine: a model reads the code, a gate checks it did, judges vote.
 *
 * It runs in the worker rather than the sandbox for one reason: the sandbox has
 * no network and the whole point of this pass is a model call. The worker holds
 * the extracted source on disk until cleanup, so the files are read here
 * directly instead of being pushed back out through the sandbox's result
 * channel, which would mean piping whole files through a JSON boundary built
 * for numbers.
 *
 * Secrets are blanked before packing. The secret scanner has already run by
 * this point, so its findings are exactly the lines to redact, and they are
 * passed in as spans. A model looking for injection bugs has no need of a
 * credential and must not be handed one in passing.
 */

/** Never walk further than this, however the repository is shaped. */
const MAX_DEPTH = 12;
const MAX_FILES = 400;

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  ".next",
  ".venv",
  "__pycache__",
  "coverage",
]);

export interface AiEngineInput {
  readonly sourcePath: string;
  readonly repositoryId: number;
  readonly repositoryName: string;
  /** Secret-scanner findings, whose lines are blanked before packing. */
  readonly review: readonly ReviewFinding[];
  readonly scout: ScoutPort;
  readonly judges: readonly JudgePort[];
  readonly tokenBudget: number;
}

export interface AiEngineResult {
  readonly coverage: SpecialistCoverageOutcome;
  /** Numeric token/bucket packet, ready for the broker. Null when nothing ran. */
  readonly packet: { readonly schemaVersion: 1; readonly groups: readonly { readonly token: number; readonly bucket: number }[] } | null;
  readonly locations: readonly FindingLocation[];
  readonly requestsSpent: number;
}

/**
 * The single directory a source archive unpacks into, if there is one.
 *
 * GitHub's tarballs wrap everything in `owner-repo-sha/`, which is a fact about
 * the download and not about the repository. The secret scanner has always
 * stripped it; the reader did not, so the first AI finding to reach a live
 * report pointed at `ri7in-W-Tech-6feceed/php/Job Insert.php`, a path that
 * exists nowhere the reader could go and look.
 */
async function archiveWrapperDirectory(root: string): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const [only] = entries;
    return entries.length === 1 && only !== undefined && only.isDirectory()
      ? only.name
      : null;
  } catch {
    return null;
  }
}

/** Drops that wrapper from a path relative to the extraction root. */
function withoutWrapper(relative: string, wrapper: string | null): string {
  if (wrapper === null) return relative;
  if (relative === wrapper) return "";
  return relative.startsWith(`${wrapper}/`)
    ? relative.slice(wrapper.length + 1)
    : relative;
}

/** Collects readable source files under a root, bounded in both depth and count. */
async function collectFiles(
  root: string,
  wrapper: string | null,
): Promise<readonly { path: string; content: string }[]> {
  const collected: { path: string; content: string }[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || collected.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= MAX_FILES) return;
      // A symlink is never followed: the archive guard already refuses them,
      // and following one here would read outside the extracted tree.
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const content = await readFile(absolute, "utf8");
        // Repository-relative, with the tarball's wrapper directory dropped.
        //
        // This is where the two sides of the redaction lookup went apart: the
        // secret scanner reports `src/config.ts` and this reported
        // `owner-repo-sha/src/config.ts`, so the exact-match lookup found
        // nothing and no line was ever blanked. Every existing test used a
        // flat fixture, so the promise held in the fixtures and nowhere else.
        const relative = withoutWrapper(path.relative(root, absolute), wrapper);
        if (relative === "") continue;
        collected.push({ path: relative, content });
      } catch {
        // Unreadable or not valid UTF-8. Skipped, never fatal.
      }
    }
  }

  await walk(root, 0);
  return collected;
}

/** Counts occurrences into the broker's four fixed buckets. */
function bucketFor(count: number): number {
  if (count <= 1) return 0;
  if (count <= 5) return 1;
  if (count <= 20) return 2;
  return 3;
}

export async function runAiEngine(
  input: AiEngineInput,
): Promise<AiEngineResult> {
  const empty: AiEngineResult = {
    coverage: "failed",
    packet: null,
    locations: [],
    requestsSpent: 0,
  };

  const wrapper = await archiveWrapperDirectory(input.sourcePath);
  const files = await collectFiles(input.sourcePath, wrapper);
  if (files.length === 0) {
    // Nothing a model could read. A clean result, not a failure.
    return { ...empty, coverage: "not_applicable" };
  }

  const pack = buildScoutPack(
    files.map((file) => ({
      repositoryId: input.repositoryId,
      repositoryName: input.repositoryName,
      path: file.path,
      content: file.content,
    })),
    {
      tokenBudget: input.tokenBudget,
      // Every line the secret scanner matched is blanked before a model sees
      // it. The pass looking for injection bugs has no use for a credential.
      redactions: input.review.map((finding) => ({
        path: finding.path,
        line: finding.startLine,
      })),
    },
  );

  if (pack.files.length === 0) {
    return { ...empty, coverage: "not_applicable" };
  }

  const funnel = new DetectionFunnel({
    scout: input.scout,
    judges: input.judges,
  });
  const result = await funnel.run(pack);

  if (result.state === "ai_not_run") {
    return { ...empty, coverage: "failed", requestsSpent: result.requestsSpent };
  }

  // Group published flags by CWE token, exactly as a scanner's findings are
  // grouped by rule. A flag naming a class outside the closed vocabulary is
  // dropped rather than guessed at.
  const counts = new Map<number, number>();
  const locations: FindingLocation[] = [];
  for (const judged of result.published) {
    const token = aiCweToken(judged.grounded.flag.cwe);
    if (token === null) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
    const entry = AI_BROKER_MANIFEST.find((item) => item.token === token);
    if (entry === undefined) continue;
    locations.push({
      engine: "ai",
      ruleId: entry.ruleId,
      path: judged.grounded.file.path,
      startLine: judged.grounded.flag.lineStart,
    });
  }

  return {
    // Partial when the batch was partly judged, when the cap left grounded
    // flags unjudged, or when the packer could not fit code it would otherwise
    // have read.
    //
    // That last one was invisible: the pack reports what it dropped and
    // nothing consumed it, so a repository the reader saw sixty percent of
    // still published a green "Reviewed".
    //
    // `not_code` is deliberately not counted. The reader reads source, so a
    // README or a lockfile being left out is the design working, not a gap,
    // and counting it turned every reviewed repository into a partial one.
    coverage:
      result.state === "ai_partial" ||
      result.unjudged > 0 ||
      pack.omitted.some((entry) => entry.reason !== "not_code") ||
      files.length >= MAX_FILES
        ? "partial"
        : "complete",
    packet: {
      schemaVersion: 1,
      groups: [...counts.entries()].map(([token, count]) => ({
        token,
        bucket: bucketFor(count),
      })),
    },
    locations,
    requestsSpent: result.requestsSpent,
  };
}
