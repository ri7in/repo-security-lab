import { describe, expect, it } from "vitest";
import { brokerResultPacketSchema } from "@app/contracts";
import { normalizeZizmor } from "@app/normalize";
import {
  zizmorVariantToken,
  type ZizmorScanResult,
} from "@app/scanners";

const decoder = new TextDecoder();

describe("hostile-domain zizmor normalizer", () => {
  it("collapses variants to strongest severity then confidence", () => {
    const result = normalizeZizmor({
      findings: [
        { ident: "artipacked", severity: "Low", confidence: "Low" },
        { ident: "artipacked", severity: "Medium", confidence: "Low" },
        { ident: "artipacked", severity: "Medium", confidence: "High" },
        {
          ident: "dangerous-triggers",
          severity: "High",
          confidence: "Medium",
        },
      ],
      locations: [],
      rawFindingCount: 4,
      findingLimitExceeded: false,
    });
    const packet = brokerResultPacketSchema.parse(
      JSON.parse(decoder.decode(result.packetBytes)),
    );
    expect(packet.groups).toEqual(
      [
        {
          token: zizmorVariantToken("artipacked", "Medium", "High"),
          bucket: 1,
        },
        {
          token: zizmorVariantToken("dangerous-triggers", "High", "Medium"),
          bucket: 0,
        },
      ].toSorted((left, right) => (left.token ?? 0) - (right.token ?? 0)),
    );
    expect(result).toMatchObject({ coverage: "complete", reason: null });
    expect(decoder.decode(result.packetBytes)).not.toContain("artipacked");
  });

  it("reports the raw finding ceiling conservatively without target-order truncation", () => {
    const findings = Array.from({ length: 1_001 }, () => ({
      ident: "unpinned-uses" as const,
      severity: "High" as const,
      confidence: "High" as const,
    }));
    const result = normalizeZizmor({
      findings,
      locations: [],
      rawFindingCount: findings.length,
      findingLimitExceeded: true,
    });
    expect(result).toMatchObject({
      coverage: "partial",
      reason: "FINDING_LIMIT",
    });
  });

  it("rejects unknown variants and inconsistent count metadata without echo", () => {
    const hostile = "RVN_TARGET_VARIANT";
    const inputs = [
      {
        findings: [{ ident: hostile, severity: "High", confidence: "High" }],
        locations: [],
      rawFindingCount: 1,
        findingLimitExceeded: false,
      },
      {
        findings: [],
        locations: [],
      rawFindingCount: 1,
        findingLimitExceeded: false,
      },
      {
        findings: [],
        locations: [],
      rawFindingCount: 1_001,
        findingLimitExceeded: true,
      },
    ] as unknown as readonly ZizmorScanResult[];
    for (const input of inputs) {
      let caught: unknown;
      try {
        normalizeZizmor(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "NORMALIZATION_REJECTED",
        message: "NORMALIZATION_REJECTED",
      });
      expect(JSON.stringify(caught)).not.toContain(hostile);
    }
  });
});
