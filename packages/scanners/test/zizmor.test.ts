/* eslint-disable @typescript-eslint/require-await -- command doubles model asynchronous child processes */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ZIZMOR_BROKER_MANIFEST,
  ZIZMOR_EXCLUDED_ONLINE_AUDITS,
  ZIZMOR_INPUT_LIMITS,
  ZIZMOR_LINUX_ARCHIVE_SHA256,
  ZIZMOR_LINUX_BINARY_SHA256,
  ZIZMOR_SOURCE_COMMIT,
  ZIZMOR_VARIANTS,
  ZIZMOR_VERSION,
  ZizmorScanner,
  zizmorVariantToken,
  type ScannerCommandRunner,
} from "@app/scanners";

const temporaryDirectories: string[] = [];
const HOSTILE = "RVN_ZIZMOR_TARGET_CANARY";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly binary: string;
  readonly binaryHash: string;
  readonly source: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-security-zizmor-"));
  temporaryDirectories.push(root);
  const binary = path.join(root, "zizmor");
  const source = path.join(root, "source");
  await writeFile(binary, "synthetic zizmor executable\n", { mode: 0o700 });
  await chmod(binary, 0o700);
  await mkdir(path.join(source, ".github", "workflows"), { recursive: true });
  await writeFile(
    path.join(source, ".github", "workflows", "target.yml"),
    `name: ${HOSTILE}\n`,
  );
  await writeFile(path.join(source, "zizmor.yml"), HOSTILE);
  return {
    root,
    binary,
    source,
    binaryHash: createHash("sha256")
      .update("synthetic zizmor executable\n")
      .digest("hex"),
  };
}

function rawFinding(
  ident = "dangerous-triggers",
  severity = "High",
  confidence = "Medium",
): Record<string, unknown> {
  return {
    ident,
    desc: HOSTILE,
    url: `https://example.invalid/${HOSTILE}`,
    determinations: { confidence, severity, persona: "Regular" },
    locations: [{ hostile: HOSTILE }],
    ignored: false,
    fixes: [{ hostile: HOSTILE }],
  };
}

function scanner(
  setup: Awaited<ReturnType<typeof fixture>>,
  runCommand: ScannerCommandRunner,
): ZizmorScanner {
  return new ZizmorScanner({
    binaryPath: setup.binary,
    expectedBinarySha256: setup.binaryHash,
    runCommand,
  });
}

function versionResult() {
  return {
    stdout: Buffer.from(`zizmor ${ZIZMOR_VERSION}\n`),
    stderr: Buffer.alloc(0),
    exitCode: 0,
  } as const;
}

describe("pinned Zizmor adapter", () => {
  it("pins a closed, unique numeric vocabulary and exact upstream artifact", () => {
    expect(ZIZMOR_VERSION).toBe("1.29.0");
    expect(ZIZMOR_SOURCE_COMMIT).toBe(
      "3c116961091b50bd1a08ffefe916469d4d90093c",
    );
    expect(ZIZMOR_LINUX_ARCHIVE_SHA256).toBe(
      "dd96df044a6e8538d5f423790f453bdd03d49e5b2bcc38214acc41a2f1297839",
    );
    expect(ZIZMOR_LINUX_BINARY_SHA256).toBe(
      "a3331b0a69fc0d8bf8087b0d74d5424602c5a0f2fc2770afe2e908a1295692b5",
    );
    expect(ZIZMOR_INPUT_LIMITS).toEqual({
      files: 128,
      fileBytes: 1_048_576,
      aggregateBytes: 4_194_304,
      findings: 1_000,
    });
    expect(ZIZMOR_VARIANTS.length).toBeGreaterThan(40);
    expect(ZIZMOR_VARIANTS.length).toBeLessThan(256);
    expect(new Set(ZIZMOR_VARIANTS.map(({ token }) => token))).toHaveLength(
      ZIZMOR_VARIANTS.length,
    );
    expect(
      new Set(
        ZIZMOR_VARIANTS.map(
          ({ ident, severity, confidence }) =>
            `${ident}\0${severity}\0${confidence}`,
        ),
      ),
    ).toHaveLength(ZIZMOR_VARIANTS.length);
    expect(ZIZMOR_BROKER_MANIFEST).toHaveLength(ZIZMOR_VARIANTS.length);
    expect(ZIZMOR_EXCLUDED_ONLINE_AUDITS).toEqual([
      "impostor-commit",
      "known-vulnerable-actions",
      "ref-confusion",
      "stale-action-refs",
    ]);
    expect(
      ZIZMOR_VARIANTS.some(({ ident }) =>
        ZIZMOR_EXCLUDED_ONLINE_AUDITS.includes(
          ident as (typeof ZIZMOR_EXCLUDED_ONLINE_AUDITS)[number],
        ),
      ),
    ).toBe(false);
    expect(
      createHash("sha256")
        .update(JSON.stringify(ZIZMOR_VARIANTS))
        .digest("hex"),
    ).toBe("11f654f42049951e2e5acaed5294cde677546679bb0444a90b444fe860986504");
    expect(zizmorVariantToken("target-invented-rule", "High", "High")).toBeNull();
  });

  it("stages only renamed workflow bytes and forces offline trusted policy", async () => {
    const setup = await fixture();
    let staged = "";
    const calls: Array<{ readonly args: readonly string[]; readonly cwd: string }> = [];
    const runCommand: ScannerCommandRunner = async (_executable, args, options) => {
      calls.push({ args: [...args], cwd: options.cwd });
      if (args[0] === "--version") return versionResult();
      staged = args.at(-1) ?? "";
      expect(path.dirname(staged)).toBe(tmpdir());
      const entries = await readdir(path.join(staged, ".github", "workflows"));
      expect(entries).toEqual(["workflow-000.yml"]);
      expect(
        await readFile(
          path.join(staged, ".github", "workflows", "workflow-000.yml"),
          "utf8",
        ),
      ).toContain(HOSTILE);
      await expect(stat(path.join(staged, "zizmor.yml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(options.acceptedExitCodes).toEqual([0, 3, 11, 12, 13, 14]);
      return {
        stdout: Buffer.from(JSON.stringify([rawFinding()])),
        stderr: Buffer.from(HOSTILE),
        exitCode: 14,
      };
    };

    const result = await scanner(setup, runCommand).scan(setup.source);

    expect(result).toEqual({
      findings: [
        {
          ident: "dangerous-triggers",
          severity: "High",
          confidence: "Medium",
        },
      ],
      rawFindingCount: 1,
      findingLimitExceeded: false,
    });
    expect(JSON.stringify(result)).not.toContain(HOSTILE);
    expect(calls[1]?.args).toEqual([
      "--offline",
      "--no-config",
      "--no-ignores",
      "--persona=regular",
      "--collect=all",
      "--strict-collection",
      "--format=json-v1",
      staged,
    ]);
    expect(calls.every(({ cwd }) => cwd === "/")).toBe(true);
    await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts an empty clean report and retains ignored only as discarded input", async () => {
    const setup = await fixture();
    const outputs = [
      { stdout: Buffer.from("[]"), exitCode: 0 },
      {
        stdout: Buffer.from(
          JSON.stringify([{ ...rawFinding(), ignored: true }]),
        ),
        exitCode: 14,
      },
    ];
    for (const expected of [0, 1]) {
      const output = outputs[expected];
      if (output === undefined) throw new Error("test fixture missing");
      const runCommand: ScannerCommandRunner = async (_executable, args) =>
        args[0] === "--version"
          ? versionResult()
          : { ...output, stderr: Buffer.alloc(0) };
      const result = await scanner(setup, runCommand).scan(setup.source);
      expect(result.findings).toHaveLength(expected);
      expect(JSON.stringify(result)).not.toContain("ignored");
    }
  });

  it("fails closed on schema, vocabulary, encoding, and exit mismatches without echo", async () => {
    const setup = await fixture();
    const invalidReports: ReadonlyArray<{
      readonly stdout: Buffer;
      readonly exitCode?: number;
    }> = [
      {
        stdout: Buffer.from(
          JSON.stringify([rawFinding("target-invented-rule")]),
        ),
        exitCode: 14,
      },
      {
        stdout: Buffer.from(
          JSON.stringify([
            {
              ...rawFinding(),
              determinations: {
                confidence: "Medium",
                severity: "High",
                persona: "Pedantic",
              },
            },
          ]),
        ),
        exitCode: 14,
      },
      {
        stdout: Buffer.from(JSON.stringify([{ ...rawFinding(), extra: HOSTILE }])),
        exitCode: 14,
      },
      { stdout: Buffer.from(JSON.stringify([rawFinding()])), exitCode: 0 },
      { stdout: Buffer.from(JSON.stringify([rawFinding()])), exitCode: 13 },
      { stdout: Buffer.from("[]"), exitCode: 3 },
      { stdout: Buffer.from("[]") },
      { stdout: Buffer.from([0xc3, 0x28]), exitCode: 0 },
    ];
    for (const output of invalidReports) {
      const runCommand: ScannerCommandRunner = async (_executable, args) =>
        args[0] === "--version"
          ? versionResult()
          : { ...output, stderr: Buffer.from(HOSTILE) };
      let caught: unknown;
      try {
        await scanner(setup, runCommand).scan(setup.source);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "SCANNER_INVALID_OUTPUT",
        message: "SCANNER_INVALID_OUTPUT",
      });
      expect(JSON.stringify(caught)).not.toContain(HOSTILE);
    }
  });

  it("enforces workflow file type and byte ceilings before the scan starts", async () => {
    const setup = await fixture();
    let scanCalls = 0;
    const runCommand: ScannerCommandRunner = async (_executable, args) => {
      if (args[0] === "--version") return versionResult();
      scanCalls += 1;
      return { stdout: Buffer.from("[]"), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    const workflow = path.join(
      setup.source,
      ".github",
      "workflows",
      "target.yml",
    );
    await rm(workflow);
    await symlink(path.join(setup.source, "zizmor.yml"), workflow);
    await expect(scanner(setup, runCommand).scan(setup.source)).rejects.toMatchObject({
      code: "SCANNER_INTERNAL",
    });
    await rm(workflow);
    await writeFile(workflow, Buffer.alloc(ZIZMOR_INPUT_LIMITS.fileBytes + 1));
    await expect(scanner(setup, runCommand).scan(setup.source)).rejects.toMatchObject({
      code: "SCANNER_MEMORY_LIMIT",
    });
    expect(scanCalls).toBe(0);
  });

  it("accepts the exact file-count ceiling and rejects one more", async () => {
    const setup = await fixture();
    const workflows = path.join(setup.source, ".github", "workflows");
    await rm(path.join(workflows, "target.yml"));
    for (let index = 0; index < ZIZMOR_INPUT_LIMITS.files; index += 1) {
      await writeFile(
        path.join(workflows, `workflow-${String(index).padStart(3, "0")}.yml`),
        "name: fixture\n",
      );
    }
    let scanCalls = 0;
    const runCommand: ScannerCommandRunner = async (_executable, args) => {
      if (args[0] === "--version") return versionResult();
      scanCalls += 1;
      return { stdout: Buffer.from("[]"), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    await expect(scanner(setup, runCommand).scan(setup.source)).resolves.toMatchObject({
      rawFindingCount: 0,
    });
    await writeFile(path.join(workflows, "workflow-over.yml"), "name: fixture\n");
    await expect(scanner(setup, runCommand).scan(setup.source)).rejects.toMatchObject({
      code: "SCANNER_MEMORY_LIMIT",
    });
    expect(scanCalls).toBe(1);
  });

  it("accepts the exact aggregate-byte ceiling and rejects one more byte", async () => {
    const setup = await fixture();
    const workflows = path.join(setup.source, ".github", "workflows");
    await rm(path.join(workflows, "target.yml"));
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        path.join(workflows, `aggregate-${index}.yml`),
        Buffer.alloc(ZIZMOR_INPUT_LIMITS.fileBytes),
      );
    }
    let scanCalls = 0;
    const runCommand: ScannerCommandRunner = async (_executable, args) => {
      if (args[0] === "--version") return versionResult();
      scanCalls += 1;
      return { stdout: Buffer.from("[]"), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    await expect(scanner(setup, runCommand).scan(setup.source)).resolves.toMatchObject({
      rawFindingCount: 0,
    });
    await writeFile(path.join(workflows, "aggregate-over.yml"), "x");
    await expect(scanner(setup, runCommand).scan(setup.source)).rejects.toMatchObject({
      code: "SCANNER_MEMORY_LIMIT",
    });
    expect(scanCalls).toBe(1);
  });

  it("refuses a binary hash mismatch before any process starts", async () => {
    const setup = await fixture();
    let called = false;
    const runCommand: ScannerCommandRunner = async () => {
      called = true;
      return versionResult();
    };
    await expect(
      new ZizmorScanner({
        binaryPath: setup.binary,
        expectedBinarySha256: "0".repeat(64),
        runCommand,
      }).verify(),
    ).rejects.toMatchObject({ code: "SCANNER_BINARY_MISMATCH" });
    expect(called).toBe(false);
  });
});
