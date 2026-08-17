import { describe, expect, it } from "vitest";
import { brokerDerivedFindingSchema } from "@app/contracts";
import {
  BrokerError,
  MAX_BROKER_PACKET_BYTES,
  SourceBlindBroker,
  type EngineManifestEntry,
} from "@app/broker";
import { normalizeGitleaks } from "@app/normalize";
import { gitleaksRuleToken } from "@app/scanners";

const encoder = new TextEncoder();
const context = {
  requestId: "req_0000000001",
  repositoryId: 123,
  commitSha: "a".repeat(40),
  ownerDetailRef: "chunk_000001",
} as const;

function manifestEntry(ruleId: string): EngineManifestEntry {
  const token = gitleaksRuleToken(ruleId);
  if (token === null) throw new Error("test manifest rule missing");
  return {
    token,
    ruleId,
    category: "secret",
    severity: "high",
    confidence: "high",
    remediationKey: "rotate-secret",
  };
}

const manifest = [
  manifestEntry("aws-access-token"),
  manifestEntry("github-pat"),
];

describe("source-blind runtime broker", () => {
  it("binds engine out-of-band and derives only trusted manifest fields", () => {
    const normalized = normalizeGitleaks({
      findings: [
        { ruleId: "github-pat" },
        { ruleId: "github-pat" },
        { ruleId: "aws-access-token" },
      ],
      rawFindingCount: 3,
      findingLimitExceeded: false,
    });
    const findings = new SourceBlindBroker("gitleaks", manifest).accept(
      normalized.packetBytes,
      context,
    );
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => brokerDerivedFindingSchema.safeParse(finding).success)).toBe(
      true,
    );
    expect(findings.map((finding) => finding.engine)).toEqual([
      "gitleaks",
      "gitleaks",
    ]);
    expect(findings.map((finding) => finding.occurrence_bucket)).toEqual([
      "one",
      "two_to_five",
    ]);
  });

  it("rejects unknown tokens and any packet-carried engine claim", () => {
    const broker = new SourceBlindBroker("gitleaks", manifest);
    for (const packet of [
      { schemaVersion: 1, groups: [{ token: 999_999, bucket: 0 }] },
      {
        schemaVersion: 1,
        engine: "osv",
        groups: [{ token: manifest[0]?.token, bucket: 0 }],
      },
    ]) {
      expect(() => broker.accept(encoder.encode(JSON.stringify(packet)), context)).toThrowError(
        expect.objectContaining({ code: "BROKER_REJECTED" }),
      );
    }
  });

  it("rejects 609 target-string smuggling variants with one fixed error", () => {
    const broker = new SourceBlindBroker("gitleaks", manifest);
    const canary = "RVN_NEVER_CROSS_THE_BROKER_7f91";
    for (let index = 0; index < 609; index += 1) {
      const packet = {
        schemaVersion: 1,
        groups: [{ token: manifest[0]?.token, bucket: 0 }],
        [`target_${index}`]: `${canary}_${index}`,
      };
      let caught: unknown;
      try {
        broker.accept(encoder.encode(JSON.stringify(packet)), context);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BrokerError);
      expect(JSON.stringify(caught)).not.toContain(canary);
      expect((caught as BrokerError).message).toBe("BROKER_REJECTED");
    }
  });

  it("rejects malformed UTF-8 and oversized bytes before deriving anything", () => {
    const broker = new SourceBlindBroker("gitleaks", manifest);
    for (const bytes of [
      new Uint8Array([0xff, 0xfe]),
      new Uint8Array(MAX_BROKER_PACKET_BYTES + 1),
    ]) {
      expect(() => broker.accept(bytes, context)).toThrowError(
        expect.objectContaining({ code: "BROKER_REJECTED" }),
      );
    }
  });

  it("allows variant manifests but rejects two tokens decoding to one rule", () => {
    const variants: readonly EngineManifestEntry[] = [
      {
        token: 1,
        ruleId: "template-injection",
        category: "workflow-security",
        severity: "low",
        confidence: "high",
        remediationKey: "harden-workflow",
      },
      {
        token: 2,
        ruleId: "template-injection",
        category: "workflow-security",
        severity: "high",
        confidence: "high",
        remediationKey: "harden-workflow",
      },
    ];
    const broker = new SourceBlindBroker("zizmor", variants);
    expect(
      broker.accept(
        encoder.encode(
          JSON.stringify({ schemaVersion: 1, groups: [{ token: 2, bucket: 0 }] }),
        ),
        context,
      )[0],
    ).toMatchObject({ rule_id: "template-injection", severity: "high" });
    expect(() =>
      broker.accept(
        encoder.encode(
          JSON.stringify({
            schemaVersion: 1,
            groups: [
              { token: 1, bucket: 0 },
              { token: 2, bucket: 0 },
            ],
          }),
        ),
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "BROKER_REJECTED" }));
  });

  it("requires duplicate-rule variants to share structural metadata", () => {
    expect(
      () =>
        new SourceBlindBroker("zizmor", [
          manifest[0] as EngineManifestEntry,
          {
            ...(manifest[0] as EngineManifestEntry),
            token: 2,
            remediationKey: "different-remediation",
          },
        ]),
    ).toThrowError("invalid broker manifest");
  });

  it("derives stable finding ids from lease identity, never packet strings", () => {
    const packet = encoder.encode(
      JSON.stringify({
        schemaVersion: 1,
        groups: [{ token: manifest[0]?.token, bucket: 0 }],
      }),
    );
    const broker = new SourceBlindBroker("gitleaks", manifest);
    const first = broker.accept(packet, context)[0];
    const retry = broker.accept(packet, context)[0];
    const otherCommit = broker.accept(packet, {
      ...context,
      commitSha: "b".repeat(40),
    })[0];
    expect(first?.finding_id).toBe(retry?.finding_id);
    expect(first?.finding_id).not.toBe(otherCommit?.finding_id);
  });
});
