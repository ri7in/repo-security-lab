export const SCANNER_ERROR_CODES = [
  "SCANNER_BINARY_MISMATCH",
  "SCANNER_TIMEOUT",
  "SCANNER_OUTPUT_LIMIT",
  "SCANNER_INVALID_OUTPUT",
  "SCANNER_INTERNAL",
] as const;

export type ScannerErrorCode = (typeof SCANNER_ERROR_CODES)[number];

/** Fixed non-echoing scanner failure; child output never becomes error text. */
export class ScannerError extends Error {
  readonly code: ScannerErrorCode;

  constructor(code: ScannerErrorCode) {
    super(code);
    this.name = "ScannerError";
    this.code = code;
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
