import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ARCHIVE_LIMITS } from "@app/archive";
import {
  OSV_RELEVANT_DEPENDENCY_BASENAMES,
  detectSpecialistApplicability,
  resolvedWalkLimits,
} from "../src/applicability.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "specialist-applicability-"));
  temporaryDirectories.push(root);
  return root;
}

async function touch(root: string, relative: string): Promise<void> {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, "fixture\n");
}

describe("name-only specialist applicability", () => {
  for (const relative of [
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
    "synthetic-root/.github/workflows/ci.yml",
    "synthetic-root/.github/workflows/ci.yaml",
  ]) {
    it(`recognizes repository-root workflow ${relative}`, async () => {
      const root = await tree();
      await touch(root, relative);
      await expect(detectSpecialistApplicability(root)).resolves.toEqual({
        osv: false,
        zizmor: true,
        opengrep: false,
      });
    });
  }

  for (const relative of [
    "x/y/.github/workflows/ci.yml",
    "synthetic-root/x/.github/workflows/ci.yml",
    ".github/workflow/ci.yml",
    ".github/workflows/ci.json",
    ".github/workflows/ci.YML",
    ".GitHub/workflows/ci.yml",
    ".github/Workflows/ci.yml",
    ".github/workflows/nested/ci.yml",
  ]) {
    it(`rejects out-of-scope workflow placement ${relative}`, async () => {
      const root = await tree();
      await touch(root, relative);
      expect((await detectSpecialistApplicability(root))?.zizmor).toBe(false);
    });
  }

  for (const [index, basename] of
    OSV_RELEVANT_DEPENDENCY_BASENAMES.entries()) {
    it(`treats ${basename} as dependency-relevant, not proven scannable`, async () => {
      const root = await tree();
      await touch(root, index % 2 === 0 ? basename : `nested/${basename}`);
      expect((await detectSpecialistApplicability(root))?.osv).toBe(true);
    });
  }

  it("keeps dependency basename matching exact-case", async () => {
    const root = await tree();
    await touch(root, "PACKAGE-LOCK.JSON");
    expect((await detectSpecialistApplicability(root))?.osv).toBe(false);
  });

  it("recognizes the complete case-insensitive JavaScript/TypeScript scope", async () => {
    const root = await tree();
    for (const extension of [
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".mjs",
      ".cjs",
      ".mts",
      ".cts",
      ".TS",
    ]) {
      await touch(root, `source/file${extension}`);
    }
    expect((await detectSpecialistApplicability(root))?.opengrep).toBe(true);
  });

  it("does not treat relevant-looking directory names as files", async () => {
    const root = await tree();
    await mkdir(path.join(root, "package.json"), { recursive: true });
    await mkdir(path.join(root, "source", "app.ts"), { recursive: true });
    await mkdir(path.join(root, ".github", "workflows", "ci.yml"), {
      recursive: true,
    });
    await expect(detectSpecialistApplicability(root)).resolves.toEqual({
      osv: false,
      zizmor: false,
      opengrep: false,
    });
  });

  it("returns whole-tree absence for unrelated regular files", async () => {
    const root = await tree();
    await touch(root, "synthetic-root/notes/readme.txt");
    await expect(detectSpecialistApplicability(root)).resolves.toEqual({
      osv: false,
      zizmor: false,
      opengrep: false,
    });
  });

  it("returns unknown when a non-file non-directory entry is observed", async () => {
    const root = await tree();
    await symlink("missing-target", path.join(root, "target-link"));
    await expect(detectSpecialistApplicability(root)).resolves.toBeNull();
  });

  it("returns unknown when the walk root cannot be read", async () => {
    const root = await tree();
    await expect(
      detectSpecialistApplicability(path.join(root, "missing")),
    ).resolves.toBeNull();
  });

  it("returns unknown rather than absence at a tightened entry ceiling", async () => {
    const root = await tree();
    await touch(root, "one.txt");
    await touch(root, "two.txt");
    await expect(
      detectSpecialistApplicability(root, { maxEntries: 1 }),
    ).resolves.toBeNull();
  });

  it("accepts a complete walk exactly at the tightened entry ceiling", async () => {
    const root = await tree();
    await touch(root, "one.txt");
    await expect(
      detectSpecialistApplicability(root, { maxEntries: 1 }),
    ).resolves.toEqual({ osv: false, zizmor: false, opengrep: false });
  });

  it("returns unknown rather than absence at a tightened depth ceiling", async () => {
    const root = await tree();
    await touch(root, "one/two.txt");
    await expect(
      detectSpecialistApplicability(root, { maxDepth: 1 }),
    ).resolves.toBeNull();
  });

  it("accepts a complete walk exactly at the tightened depth ceiling", async () => {
    const root = await tree();
    await touch(root, "one.txt");
    await expect(
      detectSpecialistApplicability(root, { maxDepth: 1 }),
    ).resolves.toEqual({ osv: false, zizmor: false, opengrep: false });
  });

  it("returns unknown rather than absence at a tightened path-byte ceiling", async () => {
    const root = await tree();
    await touch(root, "long-name.txt");
    await expect(
      detectSpecialistApplicability(root, { maxPathBytes: 4 }),
    ).resolves.toBeNull();
  });

  it("accepts a complete walk exactly at the tightened path-byte ceiling", async () => {
    const root = await tree();
    await touch(root, "four");
    await expect(
      detectSpecialistApplicability(root, { maxPathBytes: 4 }),
    ).resolves.toEqual({ osv: false, zizmor: false, opengrep: false });
  });

  it("clamps every test override at the production ceiling", () => {
    expect(
      resolvedWalkLimits({
        maxEntries: DEFAULT_ARCHIVE_LIMITS.entries + 1,
        maxDepth: DEFAULT_ARCHIVE_LIMITS.pathDepth + 1,
        maxPathBytes: DEFAULT_ARCHIVE_LIMITS.pathBytes + 1,
      }),
    ).toEqual({
      maxEntries: DEFAULT_ARCHIVE_LIMITS.entries,
      maxDepth: DEFAULT_ARCHIVE_LIMITS.pathDepth,
      maxPathBytes: DEFAULT_ARCHIVE_LIMITS.pathBytes,
    });
  });

  it("rejects invalid test overrides", () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolvedWalkLimits({ maxEntries: value })).toThrow(
        "invalid applicability walk limits",
      );
    }
  });

  it("never returns a mixed concrete result after an unvisited anomaly", async () => {
    const root = await tree();
    await touch(root, "package.json");
    await touch(root, ".github/workflows/ci.yml");
    await touch(root, "source/app.ts");
    await symlink("missing-target", path.join(root, "target-link"));
    const result = await detectSpecialistApplicability(root);
    expect(result === null || Object.values(result).every(Boolean)).toBe(true);
  });

  it("requires exhaustion before returning any absence beside an anomaly", async () => {
    const root = await tree();
    await touch(root, "package.json");
    await symlink("missing-target", path.join(root, "target-link"));
    await expect(detectSpecialistApplicability(root)).resolves.toBeNull();
  });

  it("accepts guard-legal normalized Unicode names without throwing", async () => {
    const root = await tree();
    await touch(root, "資料/résumé.txt");
    await expect(detectSpecialistApplicability(root)).resolves.toEqual({
      osv: false,
      zizmor: false,
      opengrep: false,
    });
  });
});
