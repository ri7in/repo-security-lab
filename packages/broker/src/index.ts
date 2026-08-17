import { createHash } from "node:crypto";
import {
  boundedTokenSchema,
  brokerDerivedFindingSchema,
  brokerResultPacketSchema,
  commitShaSchema,
  confidenceSchema,
  manifestTokenSchema,
  occurrenceBucketFromCode,
  opaqueIdSchema,
  scanEngineSchema,
  severitySchema,
  type BrokerDerivedFinding,
  type ScanEngine,
} from "@app/contracts";

export const MAX_BROKER_PACKET_BYTES = 64 * 1_024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class BrokerError extends Error {
  readonly code = "BROKER_REJECTED" as const;

  constructor() {
    super("BROKER_REJECTED");
    this.name = "BrokerError";
  }
}

export interface EngineManifestEntry {
  readonly token: number;
  readonly ruleId: string;
  readonly category: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "info" | "unknown";
  readonly confidence: "high" | "medium" | "low" | "unknown";
  readonly remediationKey: string;
}

export interface BrokerLeaseContext {
  readonly requestId: string;
  readonly repositoryId: number;
  readonly commitSha: string;
  readonly ownerDetailRef: string;
}

export class SourceBlindBroker {
  readonly #engine: ScanEngine;
  readonly #manifest: ReadonlyMap<number, EngineManifestEntry>;

  constructor(engine: ScanEngine, manifest: readonly EngineManifestEntry[]) {
    if (!scanEngineSchema.safeParse(engine).success || manifest.length > 256) {
      throw new Error("invalid broker manifest");
    }
    const entries = new Map<number, EngineManifestEntry>();
    const ruleShapes = new Map<
      string,
      Pick<EngineManifestEntry, "category" | "remediationKey">
    >();
    for (const entry of manifest) {
      const existingShape = ruleShapes.get(entry.ruleId);
      if (
        !manifestTokenSchema.safeParse(entry.token).success ||
        !boundedTokenSchema.safeParse(entry.ruleId).success ||
        !boundedTokenSchema.safeParse(entry.category).success ||
        !severitySchema.safeParse(entry.severity).success ||
        !confidenceSchema.safeParse(entry.confidence).success ||
        !boundedTokenSchema.safeParse(entry.remediationKey).success ||
        entries.has(entry.token) ||
        (existingShape !== undefined &&
          (existingShape.category !== entry.category ||
            existingShape.remediationKey !== entry.remediationKey))
      ) {
        throw new Error("invalid broker manifest");
      }
      entries.set(entry.token, Object.freeze({ ...entry }));
      ruleShapes.set(entry.ruleId, {
        category: entry.category,
        remediationKey: entry.remediationKey,
      });
    }
    this.#engine = engine;
    this.#manifest = entries;
  }

  accept(
    packetBytes: Uint8Array,
    context: BrokerLeaseContext,
  ): readonly BrokerDerivedFinding[] {
    try {
      if (
        packetBytes.byteLength > MAX_BROKER_PACKET_BYTES ||
        !opaqueIdSchema.safeParse(context.requestId).success ||
        !Number.isSafeInteger(context.repositoryId) ||
        context.repositoryId < 0 ||
        !commitShaSchema.safeParse(context.commitSha).success ||
        !opaqueIdSchema.safeParse(context.ownerDetailRef).success
      ) {
        throw new BrokerError();
      }
      const document = JSON.parse(decoder.decode(packetBytes)) as unknown;
      const packet = brokerResultPacketSchema.parse(document);
      const decodedRuleIds = new Set<string>();
      return packet.groups.map((group) => {
        const manifest = this.#manifest.get(group.token);
        if (manifest === undefined) throw new BrokerError();
        if (decodedRuleIds.has(manifest.ruleId)) throw new BrokerError();
        decodedRuleIds.add(manifest.ruleId);
        const digest = createHash("sha256")
          .update(
            `${context.requestId}\0${context.repositoryId}\0${context.commitSha}\0${this.#engine}\0${group.token}`,
          )
          .digest("hex")
          .slice(0, 24);
        return brokerDerivedFindingSchema.parse({
          schema_version: 1,
          finding_id: `fnd_${digest}`,
          request_id: context.requestId,
          repository_id: context.repositoryId,
          commit_sha: context.commitSha,
          engine: this.#engine,
          rule_id: manifest.ruleId,
          category: manifest.category,
          severity: manifest.severity,
          confidence: manifest.confidence,
          occurrence_bucket: occurrenceBucketFromCode(group.bucket),
          remediation_key: manifest.remediationKey,
          owner_detail_ref: context.ownerDetailRef,
        });
      });
    } catch {
      throw new BrokerError();
    }
  }
}
