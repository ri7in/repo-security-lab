import {
  MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY,
  brokerResultPacketSchema,
  type BrokerResultPacket,
  type CountBucketCode,
} from "@app/contracts";
import {
  gitleaksRuleToken,
  zizmorVariantToken,
  type GitleaksScanResult,
  type ZizmorConfidence,
  type ZizmorScanResult,
  type ZizmorSeverity,
} from "@app/scanners";

const encoder = new TextEncoder();

export class NormalizationError extends Error {
  readonly code = "NORMALIZATION_REJECTED" as const;

  constructor() {
    super("NORMALIZATION_REJECTED");
    this.name = "NormalizationError";
  }
}

export interface NormalizedResult {
  readonly packetBytes: Uint8Array;
  readonly coverage: "complete" | "partial";
  readonly reason: null | "FINDING_LIMIT";
  /**
   * Exact per-token counts behind the packet's buckets, when the normalizer
   * had them. The council needs these to remove one rejected finding from a
   * group: a bucket cannot say "two_to_five, minus one" but a count of 4 can
   * become 3. The published report still only ever sees buckets.
   */
  readonly counts?: readonly { readonly token: number; readonly count: number }[];
}

/**
 * Exported so the worker rebuilds a packet with the identical rule after the
 * council subtracts rejected findings. Two bucket functions drifting apart
 * would let a subtraction change a bucket the report never shows.
 */
export function bucketForCount(count: number): CountBucketCode {
  if (count === 1) return 0;
  if (count <= 5) return 1;
  if (count <= 20) return 2;
  return 3;
}

const bucket = bucketForCount;

const ZIZMOR_FINDING_LIMIT = 1_000;
const ZIZMOR_SEVERITY_RANK: Readonly<Record<ZizmorSeverity, number>> = {
  Informational: 0,
  Low: 1,
  Medium: 2,
  High: 3,
};
const ZIZMOR_CONFIDENCE_RANK: Readonly<Record<ZizmorConfidence, number>> = {
  Low: 0,
  Medium: 1,
  High: 2,
};

export function normalizeGitleaks(result: GitleaksScanResult): NormalizedResult {
  try {
    if (
      !Number.isSafeInteger(result.rawFindingCount) ||
      result.rawFindingCount < result.findings.length ||
      result.findings.length > 10_000 ||
      result.findingLimitExceeded !== (result.rawFindingCount > 10_000) ||
      (result.findingLimitExceeded
        ? result.findings.length !== 10_000
        : result.rawFindingCount !== result.findings.length)
    ) {
      throw new NormalizationError();
    }
    const counts = new Map<number, number>();
    for (const finding of result.findings) {
      const token = gitleaksRuleToken(finding.ruleId);
      if (token === null) throw new NormalizationError();
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    if (counts.size > MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY) {
      throw new NormalizationError();
    }
    const packet: BrokerResultPacket = {
      schemaVersion: 1,
      groups: [...counts.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([token, count]) => ({ token, bucket: bucket(count) })),
    };
    if (!brokerResultPacketSchema.safeParse(packet).success) {
      throw new NormalizationError();
    }
    return {
      packetBytes: encoder.encode(JSON.stringify(packet)),
      coverage: result.findingLimitExceeded ? "partial" : "complete",
      reason: result.findingLimitExceeded ? "FINDING_LIMIT" : null,
      counts: [...counts.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([token, count]) => ({ token, count })),
    };
  } catch {
    throw new NormalizationError();
  }
}

export function normalizeZizmor(result: ZizmorScanResult): NormalizedResult {
  try {
    if (
      !Number.isSafeInteger(result.rawFindingCount) ||
      result.rawFindingCount !== result.findings.length ||
      result.findingLimitExceeded !==
        (result.rawFindingCount > ZIZMOR_FINDING_LIMIT)
    ) {
      throw new NormalizationError();
    }

    const groups = new Map<
      string,
      {
        readonly token: number;
        readonly severity: ZizmorSeverity;
        readonly confidence: ZizmorConfidence;
        count: number;
      }
    >();
    for (const finding of result.findings) {
      const token = zizmorVariantToken(
        finding.ident,
        finding.severity,
        finding.confidence,
      );
      if (token === null) throw new NormalizationError();
      const existing = groups.get(finding.ident);
      if (existing === undefined) {
        groups.set(finding.ident, {
          token,
          severity: finding.severity,
          confidence: finding.confidence,
          count: 1,
        });
        continue;
      }
      existing.count += 1;
      const strongerSeverity =
        ZIZMOR_SEVERITY_RANK[finding.severity] >
        ZIZMOR_SEVERITY_RANK[existing.severity];
      const strongerConfidence =
        finding.severity === existing.severity &&
        ZIZMOR_CONFIDENCE_RANK[finding.confidence] >
          ZIZMOR_CONFIDENCE_RANK[existing.confidence];
      if (strongerSeverity || strongerConfidence) {
        groups.set(finding.ident, {
          token,
          severity: finding.severity,
          confidence: finding.confidence,
          count: existing.count,
        });
      }
    }
    if (groups.size > MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY) {
      throw new NormalizationError();
    }
    const packet: BrokerResultPacket = {
      schemaVersion: 1,
      groups: [...groups.values()]
        .toSorted((left, right) => left.token - right.token)
        .map((group) => ({ token: group.token, bucket: bucket(group.count) })),
    };
    if (!brokerResultPacketSchema.safeParse(packet).success) {
      throw new NormalizationError();
    }
    return {
      packetBytes: encoder.encode(JSON.stringify(packet)),
      coverage: result.findingLimitExceeded ? "partial" : "complete",
      reason: result.findingLimitExceeded ? "FINDING_LIMIT" : null,
    };
  } catch {
    throw new NormalizationError();
  }
}
