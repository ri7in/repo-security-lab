import { createReadStream } from "node:fs";
import { access, open, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { extractTarGzip, ArchiveError } from "@app/archive";
import {
  guardDomainResultSchema,
  scanDomainProbeResultSchema,
  scanDomainResultSchema,
  type FailureClass,
  type FindingLocation,
  type ReviewFinding,
} from "@app/contracts";
import { normalizeGitleaks, normalizeZizmor } from "@app/normalize";
import { GitleaksScanner, ScannerError, ZizmorScanner } from "@app/scanners";
import { detectSpecialistApplicability } from "@app/worker";

const INPUT_ARCHIVE = "/input/inbound.tar.gz";
const SOURCE_DIRECTORY = "/work/source";
const OUTPUT_FILE = "/output/result.json";
const GITLEAKS_BINARY = "/tools/gitleaks";
const GITLEAKS_CONFIG = "/config/gitleaks.toml";
const GITLEAKS_IGNORE = "/config/gitleaks.ignore";
const ZIZMOR_BINARY = "/tools/zizmor";
const PROBE_ENVIRONMENT = [
  "GITLEAKS_SHA256",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PWD",
];

function scannerFailure(error: unknown): FailureClass {
  if (error instanceof ScannerError) {
    if (error.code === "SCANNER_TIMEOUT") return "SCANNER_TIMEOUT";
    if (error.code === "SCANNER_MEMORY_LIMIT") return "SCANNER_MEMORY_LIMIT";
    if (error.code === "SCANNER_OUTPUT_LIMIT") return "SCANNER_OUTPUT_LIMIT";
  }
  return "SCANNER_INTERNAL";
}

function recordScannerFailure(
  engine: "gitleaks" | "zizmor",
  error: unknown,
): FailureClass {
  const detail =
    error instanceof ScannerError
      ? `${error.code}${error.exitCode === null ? "" : `_${error.exitCode}`}${
          error.diagnosticHint === null ? "" : `_${error.diagnosticHint}`
        }`
      : "UNEXPECTED";
  process.stderr.write(`SCAN_FAILURE:${engine}:${detail}\n`);
  return scannerFailure(error);
}

async function emit(value: unknown): Promise<void> {
  await writeFile(OUTPUT_FILE, JSON.stringify(value), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function parseJsonPacket(bytes: Uint8Array): unknown {
  const decoded: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  return decoded;
}

async function guard(): Promise<void> {
  try {
    await extractTarGzip(createReadStream(INPUT_ARCHIVE), SOURCE_DIRECTORY);
    await emit(guardDomainResultSchema.parse({ ok: true }));
  } catch (error) {
    await emit(
      guardDomainResultSchema.parse({
        ok: false,
        reason: error instanceof ArchiveError ? error.code : "ARCHIVE_INVALID",
      }),
    );
  }
}

async function networkIsDenied(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (denied: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(denied);
    };
    socket.setTimeout(500, () => finish(true));
    socket.once("error", () => finish(true));
    socket.connect(53, "1.1.1.1", () => finish(false));
  });
}

async function credentialPathsAreHidden(): Promise<boolean> {
  const paths = ["/etc/passwd", "/root/.ssh", "/run/secrets", "/home/ubuntu/.ssh"];
  const results = await Promise.all(
    paths.map(async (filename) => {
      try {
        await access(filename);
        return false;
      } catch {
        return true;
      }
    }),
  );
  return results.every(Boolean);
}

async function outsideWriteIsDenied(): Promise<boolean> {
  try {
    const handle = await open("/escape", "wx", 0o600);
    await handle.close();
    return false;
  } catch {
    return true;
  }
}

async function probe(): Promise<void> {
  const allowedEnvironment = [
    ...PROBE_ENVIRONMENT,
    ...(process.env["ZIZMOR_SHA256"] === undefined ? [] : ["ZIZMOR_SHA256"]),
  ].sort();
  const environmentClean =
    JSON.stringify(Object.keys(process.env).sort()) ===
      JSON.stringify(allowedEnvironment) &&
    process.env["HOME"] === "/nonexistent" &&
    process.env["LANG"] === "C" &&
    process.env["LC_ALL"] === "C" &&
    process.env["PATH"] === "/runtime/bin:/tools" &&
    process.env["PWD"] === "/work" &&
    /^[a-f0-9]{64}$/u.test(process.env["GITLEAKS_SHA256"] ?? "") &&
    (process.env["ZIZMOR_SHA256"] === undefined ||
      /^[a-f0-9]{64}$/u.test(process.env["ZIZMOR_SHA256"]));
  const [networkDenied, credentialPathsHidden, outsideWriteDenied] = await Promise.all([
    networkIsDenied(),
    credentialPathsAreHidden(),
    outsideWriteIsDenied(),
  ]);
  await emit(
    scanDomainProbeResultSchema.parse({
      schemaVersion: 1,
      networkDenied,
      credentialPathsHidden,
      outsideWriteDenied,
      environmentClean,
    }),
  );
}

async function scan(): Promise<void> {
  const detected = await detectSpecialistApplicability(SOURCE_DIRECTORY);
  const applicability = detected ?? { osv: true, zizmor: true, opengrep: true };
  const engineResults: unknown[] = [];
  const engineFailures: Partial<Record<"gitleaks" | "zizmor", FailureClass>> = {};
  let locations: readonly FindingLocation[] = [];
  let review: readonly ReviewFinding[] = [];
  let reviewComplete = false;
  try {
    const expectedBinarySha256 = process.env["GITLEAKS_SHA256"] ?? "";
    const scanned = await new GitleaksScanner({
      binaryPath: GITLEAKS_BINARY,
      expectedBinarySha256,
      // Review context is gathered here, inside the sandbox, because it needs
      // to read the extracted files. It is judged outside, in the worker,
      // which is the only side with a network.
      collectReview: true,
      trustedConfigPath: GITLEAKS_CONFIG,
      trustedIgnorePath: GITLEAKS_IGNORE,
    }).scan(SOURCE_DIRECTORY);
    locations = scanned.locations;
    review = scanned.review ?? [];
    reviewComplete = scanned.reviewComplete ?? false;
    const normalized = normalizeGitleaks(scanned);
    engineResults.push({
      engine: "gitleaks",
      coverage: normalized.coverage,
      reason: normalized.reason,
      packet: parseJsonPacket(normalized.packetBytes),
      // Exact counts behind the buckets, so the council outside can subtract
      // a single rejected finding. Numeric only, schema-bounded.
      counts: normalized.counts,
    });
  } catch (error) {
    engineFailures.gitleaks = recordScannerFailure("gitleaks", error);
  }
  const zizmorSha256 = process.env["ZIZMOR_SHA256"];
  if (zizmorSha256 !== undefined && applicability.zizmor) {
    try {
      const normalized = normalizeZizmor(
        await new ZizmorScanner({
          binaryPath: ZIZMOR_BINARY,
          expectedBinarySha256: zizmorSha256,
        }).scan(SOURCE_DIRECTORY),
      );
      engineResults.push({
        engine: "zizmor",
        coverage: normalized.coverage,
        reason: normalized.reason,
        packet: parseJsonPacket(normalized.packetBytes),
      });
    } catch (error) {
      engineFailures.zizmor = recordScannerFailure("zizmor", error);
    }
  }
  await emit(
    scanDomainResultSchema.parse({
      schemaVersion: 1,
      applicability,
      engineResults,
      engineFailures,
      locations,
      review,
      reviewComplete,
    }),
  );
}

const mode = process.argv[2];
if (mode === "guard") {
  await guard();
} else if (mode === "scan") {
  await scan();
} else if (mode === "probe") {
  await probe();
} else {
  process.exitCode = 64;
}
