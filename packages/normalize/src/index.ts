import {
  MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY,
  brokerResultPacketSchema,
  type BrokerResultPacket,
  type CountBucketCode,
} from "@app/contracts";
import {
  gitleaksRuleToken,
  type GitleaksScanResult,
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
}

function bucket(count: number): CountBucketCode {
  if (count === 1) return 0;
  if (count <= 5) return 1;
  if (count <= 20) return 2;
  return 3;
}

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
    };
  } catch {
    throw new NormalizationError();
  }
}
