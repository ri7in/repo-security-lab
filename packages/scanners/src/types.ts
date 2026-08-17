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

/** Fixed non-echoing scanner failure; child output never becomes error text. */
export class ScannerError extends Error {
  readonly code: ScannerErrorCode;
  readonly exitCode: number | null;

  constructor(code: ScannerErrorCode, exitCode?: number) {
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
  }
}

export interface ScannerRuleFinding {
  readonly ruleId: string;
}

export interface GitleaksScanResult {
  readonly findings: readonly ScannerRuleFinding[];
  readonly rawFindingCount: number;
  readonly findingLimitExceeded: boolean;
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
