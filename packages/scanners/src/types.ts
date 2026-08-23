import type { FindingLocation, ReviewFinding } from "@app/contracts";
export const SCANNER_ERROR_CODES = [
  "SCANNER_BINARY_MISMATCH",
  "SCANNER_TIMEOUT",
  "SCANNER_MEMORY_LIMIT",
  "SCANNER_OUTPUT_LIMIT",
  "SCANNER_INVALID_OUTPUT",
  "SCANNER_INPUT_FAILURE",
  "SCANNER_STAGE_FAILURE",
  "SCANNER_EXIT_FAILURE",
  "SCANNER_INTERNAL",
] as const;

export type ScannerErrorCode = (typeof SCANNER_ERROR_CODES)[number];

export const SCANNER_DIAGNOSTIC_HINTS = [
  "READ_ONLY_FILESYSTEM",
  "PERMISSION_DENIED",
  "MISSING_PATH",
  "RESOURCE_LIMIT",
  "PANIC",
  "OTHER",
] as const;
export type ScannerDiagnosticHint = (typeof SCANNER_DIAGNOSTIC_HINTS)[number];

/** Fixed non-echoing scanner failure; child output never becomes error text. */
export class ScannerError extends Error {
  readonly code: ScannerErrorCode;
  readonly exitCode: number | null;
  readonly diagnosticHint: ScannerDiagnosticHint | null;

  constructor(
    code: ScannerErrorCode,
    exitCode?: number,
    diagnosticHint?: ScannerDiagnosticHint,
  ) {
    super(code);
    this.name = "ScannerError";
    this.code = code;
    this.exitCode =
      code === "SCANNER_EXIT_FAILURE" &&
      exitCode !== undefined &&
      Number.isSafeInteger(exitCode) &&
      exitCode >= 0 &&
      exitCode <= 255
        ? exitCode
        : null;
    this.diagnosticHint =
      code === "SCANNER_EXIT_FAILURE" && diagnosticHint !== undefined
        ? diagnosticHint
        : null;
  }
}

export interface ScannerRuleFinding {
  readonly ruleId: string;
}

export interface GitleaksScanResult {
  readonly findings: readonly ScannerRuleFinding[];
  readonly rawFindingCount: number;
  readonly findingLimitExceeded: boolean;
  /**
   * Bounded review context, present only when the caller asked for it. This is
   * the sole archive-derived data the scanner returns; it reaches the worker
   * and stops there. See `reviewFindingSchema` for why it exists and what
   * guarantee it changes.
   */
  readonly review?: readonly ReviewFinding[];
  /**
   * True only when every finding produced a review entry. Suppression is only
   * permitted on a fully reviewed engine result, because the published report
   * uses coarse count buckets that cannot express a partial reduction.
   */
  readonly reviewComplete?: boolean;
  /**
   * Where each finding sits, present only when the caller asked for it.
   *
   * Unlike `review`, this is published. It carries a path and a line and has
   * no field able to hold a snippet or a value, and gitleaks runs redacted so
   * the value does not exist on this side of the scanner to leak.
   */
  readonly locations: readonly FindingLocation[];
}

export const ZIZMOR_SEVERITIES = [
  "Informational",
  "Low",
  "Medium",
  "High",
] as const;
export type ZizmorSeverity = (typeof ZIZMOR_SEVERITIES)[number];

export const ZIZMOR_CONFIDENCES = ["Low", "Medium", "High"] as const;
export type ZizmorConfidence = (typeof ZIZMOR_CONFIDENCES)[number];

/** The only string-bearing facts retained inside the hostile scan domain. */
export interface ZizmorRuleFinding {
  readonly ident: string;
  readonly severity: ZizmorSeverity;
  readonly confidence: ZizmorConfidence;
}

export interface ZizmorScanResult {
  readonly findings: readonly ZizmorRuleFinding[];
  readonly rawFindingCount: number;
  readonly findingLimitExceeded: boolean;
}

export interface FailClosedScannerStub {
  readonly engine: "osv" | "zizmor" | "opengrep";
  scan(): Promise<never>;
}

export function failClosedScannerStub(
  engine: FailClosedScannerStub["engine"],
): FailClosedScannerStub {
  return {
    engine,
    scan() {
      return Promise.reject(new ScannerError("SCANNER_INTERNAL"));
    },
  };
}
