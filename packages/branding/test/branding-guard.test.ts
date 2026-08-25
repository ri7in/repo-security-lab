/**
 * Mechanical-rename guard (D-067).
 *
 * The placeholder product name may exist as a literal only in:
 *  - `packages/branding/src/index.ts` (the single branding source),
 *  - `README.md` (explicit README allowance),
 *  - `pnpm-lock.yaml` (lock metadata, if a lockfile entry is ever unavoidable).
 *  - `apps/control-plane/wrangler.jsonc` (external deployment resource names).
 *
 * This test never states the placeholder literal itself; it reads the current
 * value from the branding module, so the guard survives renames unchanged.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { branding } from "@app/branding";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "tmp",
]);

const ALLOWED_FILES = new Set([
  // GitHub's own metadata files. They are the first thing a visitor or a
  // security researcher reads, and a policy that will not say where the live
  // service is helps nobody. Every one of them is listed in the rename
  // checklist in docs/maintenance.md, so the promise that a rename is
  // mechanical still holds.
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "pnpm-lock.yaml",
  path.join("packages", "branding", "src", "index.ts"),
  path.join("apps", "control-plane", "wrangler.jsonc"),
]);

/**
 * The guard scans text files only, so a future binary fixture (test archive,
 * image) cannot crash the UTF-8 read. The lists must cover every place a name
 * literal could realistically leak: source, tests, docs, and configuration.
 */
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const TEXT_BASENAMES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "LICENSE",
]);

function isTextFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return (
    TEXT_BASENAMES.has(base) ||
    TEXT_EXTENSIONS.has(path.extname(base).toLowerCase())
  );
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        yield* walk(absolute);
      }
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}

describe("branding", () => {
  it("exposes a url/package/repository-safe slug", () => {
    expect(branding.productSlug).toMatch(/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/);
    expect(branding.productSlug).not.toContain("--");
  });

  it("keeps the repository url derived from the slug", () => {
    expect(branding.repoUrl).toBe(
      `https://github.com/ri7in/${branding.productSlug}`,
    );
  });

  it("has no empty identity fields", () => {
    for (const value of Object.values(branding)) {
      if (typeof value === "string") {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("rename guard", () => {
  it("finds the name literals only in branding source and allowed metadata", () => {
    const literals = [
      branding.productSlug.toLowerCase(),
      branding.productDisplayName.toLowerCase(),
    ];
    const offenders: string[] = [];
    const scanned: string[] = [];

    for (const file of walk(repoRoot)) {
      const relative = path.relative(repoRoot, file);
      if (ALLOWED_FILES.has(relative) || !isTextFile(file)) {
        continue;
      }
      scanned.push(relative);
      const content = readFileSync(file, "utf8").toLowerCase();
      for (const literal of literals) {
        if (content.includes(literal)) {
          offenders.push(`${relative} contains "${literal}"`);
        }
      }
    }

    expect(offenders).toEqual([]);

    // Non-vacuity: the text filter must not silently exclude the places a
    // literal would realistically leak (source, docs, config).
    expect(scanned.length).toBeGreaterThan(10);
    for (const expected of [
      "package.json",
      path.join("docs", "architecture.md"),
      path.join("packages", "contracts", "src", "index.ts"),
      "eslint.config.mjs",
      ".gitignore",
    ]) {
      expect(scanned).toContain(expected);
    }
  });

  it("guards against an accidentally emptied allowlist", () => {
    // The branding source itself must always be reachable by the walker and
    // contain the slug; otherwise the guard would silently test nothing.
    const brandingSource = readFileSync(
      path.join(repoRoot, "packages", "branding", "src", "index.ts"),
      "utf8",
    );
    expect(brandingSource).toContain(branding.productSlug);
    expect(brandingSource).toContain(branding.productDisplayName);
  });
});
