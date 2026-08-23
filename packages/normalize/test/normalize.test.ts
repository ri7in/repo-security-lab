import { describe, expect, it } from "vitest";
import { brokerResultPacketSchema } from "@app/contracts";
import { normalizeGitleaks } from "@app/normalize";
import { gitleaksRuleToken } from "@app/scanners";

const decoder = new TextDecoder();

describe("hostile-domain Gitleaks normalizer", () => {
  it("reduces rule occurrences to sorted numeric tokens and fixed buckets", () => {
    const result = normalizeGitleaks({
      findings: [
        ...Array.from({ length: 6 }, () => ({ ruleId: "github-pat" })),
        { ruleId: "aws-access-token" },
      ],
      rawFindingCount: 7,
      findingLimitExceeded: false,
      locations: [],
    });
    const packet = brokerResultPacketSchema.parse(
      JSON.parse(decoder.decode(result.packetBytes)),
    );
    expect(packet.groups).toEqual([
      { token: gitleaksRuleToken("aws-access-token"), bucket: 0 },
      { token: gitleaksRuleToken("github-pat"), bucket: 2 },
    ]);
    expect(result).toMatchObject({ coverage: "complete", reason: null });
    expect(decoder.decode(result.packetBytes)).not.toContain("github-pat");
  });

  it("carries a fixed partial outcome when the scanner hit its ceiling", () => {
    const findings = Array.from({ length: 10_000 }, () => ({
      ruleId: "generic-api-key",
    }));
    const result = normalizeGitleaks({
      findings,
      rawFindingCount: 10_001,
      findingLimitExceeded: true,
      locations: [],
    });
    expect(result).toMatchObject({
      coverage: "partial",
      reason: "FINDING_LIMIT",
    });
  });

  it("rejects unknown rules and inconsistent ceiling metadata without echo", () => {
    const hostile = "RVN_TARGET_CONTROLLED_RULE";
    for (const input of [
      {
        findings: [{ ruleId: hostile }],
        rawFindingCount: 1,
        findingLimitExceeded: false,
        locations: [],
      },
      {
        findings: [],
        rawFindingCount: 10_001,
        findingLimitExceeded: true,
        locations: [],
      },
      {
        findings: [],
        rawFindingCount: 1,
        findingLimitExceeded: false,
        locations: [],
      },
    ]) {
      expect(() => normalizeGitleaks(input)).toThrowError(
        expect.objectContaining({
          code: "NORMALIZATION_REJECTED",
          message: "NORMALIZATION_REJECTED",
        }),
      );
    }
  });
});
