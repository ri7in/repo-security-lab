import { describe, expect, it } from "vitest";
import {
  MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY,
  brokerDerivedFindingSchema,
  brokerGroupSchema,
  brokerResultPacketSchema,
  countBucketCodeSchema,
  occurrenceBucketFromCode,
} from "@app/contracts";

// Engine identity is fixed out-of-band by the broker-owned channel/lease;
// the hostile packet itself may carry only schemaVersion and numeric groups.
const validPacket = {
  schemaVersion: 1,
  groups: [
    { token: 0, bucket: 0 },
    { token: 41, bucket: 3 },
  ],
} as const;

describe("count buckets", () => {
  it("maps the four codes to the fixed labels", () => {
    expect(occurrenceBucketFromCode(0)).toBe("one");
    expect(occurrenceBucketFromCode(1)).toBe("two_to_five");
    expect(occurrenceBucketFromCode(2)).toBe("six_to_twenty");
    expect(occurrenceBucketFromCode(3)).toBe("twenty_one_plus");
  });

  it("rejects out-of-range and non-integer codes", () => {
    for (const bad of [-1, 4, 1.5, Number.NaN, "1", null]) {
      expect(countBucketCodeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("broker result packet", () => {
  it("accepts a valid numeric-token packet", () => {
    expect(brokerResultPacketSchema.safeParse(validPacket).success).toBe(true);
  });

  it("accepts an empty group list and the exact 256-group ceiling", () => {
    expect(
      brokerResultPacketSchema.safeParse({ ...validPacket, groups: [] })
        .success,
    ).toBe(true);
    const maxGroups = Array.from(
      { length: MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY },
      (_, index) => ({ token: index, bucket: 0 }),
    );
    expect(
      brokerResultPacketSchema.safeParse({ ...validPacket, groups: maxGroups })
        .success,
    ).toBe(true);
  });

  it("rejects one group above the 256 ceiling", () => {
    const tooMany = Array.from(
      { length: MAX_BROKER_GROUPS_PER_ENGINE_REPOSITORY + 1 },
      (_, index) => ({ token: index, bucket: 0 }),
    );
    expect(
      brokerResultPacketSchema.safeParse({ ...validPacket, groups: tooMany })
        .success,
    ).toBe(false);
  });

  it("rejects duplicate manifest tokens", () => {
    expect(
      brokerResultPacketSchema.safeParse({
        ...validPacket,
        groups: [
          { token: 7, bucket: 0 },
          { token: 7, bucket: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects every attempt to smuggle a string through the boundary", () => {
    const hostilePackets = [
      // String token: the classic exfiltration attempt.
      { ...validPacket, groups: [{ token: "AKIAIOSFODNN7EXAMPLE", bucket: 0 }] },
      // Path in an extra group key.
      { ...validPacket, groups: [{ token: 1, bucket: 0, path: "src/.env" }] },
      // Extra packet key carrying prose.
      { ...validPacket, note: "found secret sk-live-1234" },
      // Engine claim as injection carrier.
      { ...validPacket, engine: "gitleaks; DROP TABLE findings" },
      // Non-integer and negative tokens.
      { ...validPacket, groups: [{ token: 1.25, bucket: 0 }] },
      { ...validPacket, groups: [{ token: -1, bucket: 0 }] },
      // Unsafe-integer token.
      { ...validPacket, groups: [{ token: Number.MAX_SAFE_INTEGER + 2, bucket: 0 }] },
      // Bucket out of range.
      { ...validPacket, groups: [{ token: 1, bucket: 4 }] },
      // Wrong schema version.
      { ...validPacket, schemaVersion: 2 },
      // Missing groups.
      { schemaVersion: 1 },
    ];
    for (const packet of hostilePackets) {
      expect(brokerResultPacketSchema.safeParse(packet).success).toBe(false);
    }
  });

  it("rejects even a valid engine name: engine identity is out-of-band", () => {
    // "gitleaks" is a real engine, but the hostile domain may never assert
    // engine identity inside the packet; the broker channel/lease fixes it.
    expect(
      brokerResultPacketSchema.safeParse({ ...validPacket, engine: "gitleaks" })
        .success,
    ).toBe(false);
  });

  it("rejects extra keys at the group level even when values look numeric", () => {
    expect(
      brokerGroupSchema.safeParse({ token: 1, bucket: 0, count: 999 }).success,
    ).toBe(false);
  });
});

describe("broker-derived finding", () => {
  const validFinding = {
    schema_version: 1,
    finding_id: "fnd_0000000001",
    request_id: "req_0000000001",
    repository_id: 123,
    commit_sha: "a".repeat(40),
    engine: "gitleaks",
    rule_id: "generic-api-key",
    category: "secret",
    severity: "high",
    confidence: "high",
    occurrence_bucket: "two_to_five",
    remediation_key: "rotate-secret",
    owner_detail_ref: "chunk_000001",
  } as const;

  it("accepts the accepted schema_version 1 shape", () => {
    expect(brokerDerivedFindingSchema.safeParse(validFinding).success).toBe(
      true,
    );
  });

  it("cannot express paths, snippets, messages, or secrets", () => {
    const hostileFindings = [
      { ...validFinding, path: "src/config/.env" },
      { ...validFinding, snippet: "const key = 'sk-live-1234'" },
      { ...validFinding, message: "hardcoded secret at line 10" },
      { ...validFinding, rule_id: "../../etc/passwd" },
      { ...validFinding, rule_id: "rule with spaces and prose" },
      { ...validFinding, category: "secret: sk-live-1234" },
      { ...validFinding, severity: "catastrophic" },
      { ...validFinding, commit_sha: "not-a-sha" },
      { ...validFinding, finding_id: "id with spaces" },
    ];
    for (const finding of hostileFindings) {
      expect(brokerDerivedFindingSchema.safeParse(finding).success).toBe(false);
    }
  });
});
