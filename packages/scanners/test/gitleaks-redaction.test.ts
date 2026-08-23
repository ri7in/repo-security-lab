import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitleaksScanner } from "@app/scanners";

/**
 * Real-binary proof that a credential never reaches a review excerpt.
 *
 * This test exists because the mocked ones lied. They fed the adapter a
 * synthetic gitleaks response and a fixture file whose contents were literally
 * the word REDACTED, so "no secret in the excerpt" passed trivially while the
 * real pipeline shipped the actual credential to a model.
 *
 * `--redact` only redacts gitleaks' own JSON output. Excerpts are read from the
 * file on disk, which still holds the real value. Only a real binary reading a
 * real secret out of a real file can prove the blanking works, so this runs the
 * real binary.
 */

const binaryPath = process.env["GITLEAKS_BINARY"];
const binaryHash = process.env["GITLEAKS_SHA256"];
const enabled = binaryPath !== undefined && binaryHash !== undefined;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Split so this file is not itself a secret-scanner finding.
const SECRET = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const SECOND = ["ghp", "_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("");

function windows(value: string, size: number): string[] {
  return Array.from({ length: Math.max(0, value.length - size + 1) }, (_, index) =>
    value.slice(index, index + size),
  );
}

async function scanFixture(
  files: Record<string, string>,
): Promise<Awaited<ReturnType<GitleaksScanner["scan"]>>> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-redact-"));
  temporaryDirectories.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return await new GitleaksScanner({
    binaryPath: binaryPath ?? "",
    expectedBinarySha256: binaryHash ?? "",
    collectReview: true,
  }).scan(root);
}

describe.skipIf(!enabled)("review excerpts never carry a real credential", () => {
  it("blanks the matched secret out of its own excerpt", async () => {
    const result = await scanFixture({
      "src/config.ts": `const config = {\n  apiKey: "${SECRET}",\n};\n`,
    });

    expect(result.review?.length ?? 0).toBeGreaterThan(0);
    const serialized = JSON.stringify(result.review);
    expect(serialized).not.toContain(SECRET);
    // Whole-string absence is not enough. The first attempt left a single
    // leading character of the credential visible because the reported column
    // was off by one, so every window of the secret is checked, not just the
    // whole of it.
    for (const window of windows(SECRET, 6)) {
      expect(serialized, `secret fragment survived: ${window}`).not.toContain(
        window,
      );
    }
    // The surrounding code must survive, or the judge has nothing to judge.
    expect(serialized).toContain("apiKey");
  }, 120_000);

  it("blanks a neighbouring secret that falls inside another excerpt", async () => {
    // The window around finding one spans finding two. Redacting only the
    // finding being described would publish the neighbour verbatim.
    const lines = [
      "const a = {",
      `  first: "${SECRET}",`,
      `  second: "${SECOND}",`,
      "};",
    ].join("\n");
    const result = await scanFixture({ "src/pair.ts": lines });

    const serialized = JSON.stringify(result.review);
    for (const secret of [SECRET, SECOND]) {
      for (const window of windows(secret, 6)) {
        expect(serialized, `secret fragment survived: ${window}`).not.toContain(
          window,
        );
      }
    }
  }, 120_000);

  it("keeps the finding even though its value is blanked", async () => {
    const result = await scanFixture({
      "src/config.ts": `const apiKey = "${SECRET}";\n`,
    });
    // Redaction changes what a reviewer sees, never what was counted.
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.reviewComplete).toBe(true);
  }, 120_000);
});
