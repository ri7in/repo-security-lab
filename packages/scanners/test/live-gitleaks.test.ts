import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { GitleaksScanner } from "@app/scanners";

const enabled = process.env["RUN_GITLEAKS"] === "1";
const binaryPath = process.env["GITLEAKS_BINARY"];
const binaryHash = process.env["GITLEAKS_SHA256"];
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test.skipIf(!enabled || binaryPath === undefined || binaryHash === undefined)(
  "runs the exact verified Gitleaks binary with target config disabled",
  async () => {
    if (binaryPath === undefined || binaryHash === undefined) {
      throw new Error("verified Gitleaks fixture is unavailable");
    }
    const source = await mkdtemp(path.join(tmpdir(), "repo-security-gitleaks-"));
    temporaryDirectories.push(source);
    const highEntropyBody = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5zA7";
    const syntheticSecret = ["ghp", "_", highEntropyBody].join("");
    await writeFile(path.join(source, "credential.txt"), syntheticSecret);
    await writeFile(
      path.join(source, ".gitleaks.toml"),
      'title = "target config must never replace trusted rules"\n',
    );

    const result = await new GitleaksScanner({
      binaryPath,
      expectedBinarySha256: binaryHash,
    }).scan(source);
    expect(result.rawFindingCount).toBeGreaterThan(0);
    expect(result.findings.some((finding) => finding.ruleId === "github-pat")).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain(syntheticSecret);
  },
  30_000,
);
