import { readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ARCHIVE_LIMITS } from "@app/archive";

/**
 * Relevance is intentionally broader than proven scanner support. Presence of
 * any name below means dependency input may exist and remains `unsupported`;
 * only package-lock.json has passed the current pinned-OSV parser preflight.
 */
export const OSV_RELEVANT_DEPENDENCY_BASENAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "package.json",
] as const;

const OPENGREP_RELEVANT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

export interface SpecialistApplicability {
  readonly osv: boolean;
  readonly zizmor: boolean;
  readonly opengrep: boolean;
}

export interface ApplicabilityWalkLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxPathBytes: number;
}

const DEFAULT_WALK_LIMITS: ApplicabilityWalkLimits = Object.freeze({
  maxEntries: DEFAULT_ARCHIVE_LIMITS.entries,
  maxDepth: DEFAULT_ARCHIVE_LIMITS.pathDepth,
  maxPathBytes: DEFAULT_ARCHIVE_LIMITS.pathBytes,
});

function resolvedLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("invalid applicability walk limits");
  }
  return Math.min(value, ceiling);
}

/** Test overrides can only tighten, never raise, the production ceilings. */
export function resolvedWalkLimits(
  overrides: Partial<ApplicabilityWalkLimits> = {},
): ApplicabilityWalkLimits {
  return Object.freeze({
    maxEntries: resolvedLimit(
      overrides.maxEntries,
      DEFAULT_WALK_LIMITS.maxEntries,
    ),
    maxDepth: resolvedLimit(overrides.maxDepth, DEFAULT_WALK_LIMITS.maxDepth),
    maxPathBytes: resolvedLimit(
      overrides.maxPathBytes,
      DEFAULT_WALK_LIMITS.maxPathBytes,
    ),
  });
}

function isWorkflow(segments: readonly string[]): boolean {
  const offset = segments.length === 3 ? 0 : segments.length === 4 ? 1 : -1;
  if (offset === -1) return false;
  const name = segments[offset + 2];
  return (
    segments[offset] === ".github" &&
    segments[offset + 1] === "workflows" &&
    name !== undefined &&
    (name.endsWith(".yml") || name.endsWith(".yaml"))
  );
}

/**
 * Reads names and entry types only. A false value is returned only after a
 * complete anomaly-free walk. An all-true result may return early because it
 * contains no absence claim. Null means relevant input presence was not ruled
 * out and maps conservatively to `unsupported`.
 *
 * The walk limit is independent of the tar-header limit: extraction may create
 * implicit parent directories, so even a guard-valid tree can conservatively
 * reach null here.
 */
export async function detectSpecialistApplicability(
  root: string,
  overrides: Partial<ApplicabilityWalkLimits> = {},
): Promise<SpecialistApplicability | null> {
  const limits = resolvedWalkLimits(overrides);
  const pending: Array<{
    readonly directory: string;
    readonly segments: readonly string[];
  }> = [{ directory: root, segments: [] }];
  let observedEntries = 0;
  let osv = false;
  let zizmor = false;
  let opengrep = false;

  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const entries = await readdir(current.directory, { withFileTypes: true });
      for (const entry of entries) {
        observedEntries += 1;
        if (observedEntries > limits.maxEntries) return null;
        const segments = [...current.segments, entry.name];
        if (
          segments.length > limits.maxDepth ||
          Buffer.byteLength(segments.join("/"), "utf8") > limits.maxPathBytes
        ) {
          return null;
        }
        const candidate = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          pending.push({ directory: candidate, segments });
          continue;
        }
        if (!entry.isFile()) return null;

        const basename = entry.name;
        if (
          OSV_RELEVANT_DEPENDENCY_BASENAMES.includes(
            basename as (typeof OSV_RELEVANT_DEPENDENCY_BASENAMES)[number],
          )
        ) {
          osv = true;
        }
        if (isWorkflow(segments)) zizmor = true;
        if (
          OPENGREP_RELEVANT_EXTENSIONS.has(
            path.extname(basename).toLocaleLowerCase("en-US"),
          )
        ) {
          opengrep = true;
        }
        if (osv && zizmor && opengrep) {
          return { osv, zizmor, opengrep };
        }
      }
    }
    return { osv, zizmor, opengrep };
  } catch {
    return null;
  }
}
