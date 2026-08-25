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

test.skipIf(!enabled || binaryPath === undefined || binaryHash === undefined)(
  "drops Stripe publishable keys but keeps the real secrets beside them",
  async () => {
    if (binaryPath === undefined || binaryHash === undefined) {
      throw new Error("verified Gitleaks fixture is unavailable");
    }
    const source = await mkdtemp(path.join(tmpdir(), "repo-security-gitleaks-pk-"));
    temporaryDirectories.push(source);
    // A publishable key behind a key-shaped name is exactly the shape that
    // produced a false positive on a real account: gitleaks' generic-api-key
    // rule fires on it. The two real secrets on the lines around it must
    // survive, which is what proves the allowlist targets the value and not
    // the line.
    const publishable = ["pk", "test", "TYooMQauvdEDq54NiTphI7jx"].join("_");
    const stripeSecret = ["sk", "test", "51H8xIgK9pQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUi"].join("_");
    const ghToken = ["ghp", "aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW3xY5zA7"].join("_");
    await writeFile(
      path.join(source, "config.jsx"),
      [
        "export const config = {",
        `  publishableKey: "${publishable}",`,
        `  stripeSecretKey: "${stripeSecret}",`,
        `  githubToken: "${ghToken}",`,
        "};",
        "",
      ].join("\n"),
    );

    const result = await new GitleaksScanner({
      binaryPath,
      expectedBinarySha256: binaryHash,
    }).scan(source);

    // The publishable key is gone: no finding sits on its line.
    const publishableLine = 2;
    expect(
      result.locations.some((location) => location.startLine === publishableLine),
    ).toBe(false);
    // The real Stripe secret key and the GitHub token both survive.
    expect(
      result.findings.some((finding) => finding.ruleId === "stripe-access-token"),
    ).toBe(true);
    expect(
      result.findings.some((finding) => finding.ruleId === "github-pat"),
    ).toBe(true);
    // And no raw value ever leaves the scanner.
    expect(JSON.stringify(result)).not.toContain(publishable);
    expect(JSON.stringify(result)).not.toContain(stripeSecret);
  },
  30_000,
);
