import { describe, expect, it, vi } from "vitest";
import type { BrokerResultPacket, ReviewFinding } from "@app/contracts";
import {
  applySuppression,
  renderFindingReviewPrompt,
  reviewScannerFindings,
} from "../src/index.js";
import type { JudgePort } from "../src/ports.js";

function judge(family: string, verdict: string): JudgePort {
  return {
    family,
    review: vi.fn(() => Promise.resolve({ verdict, reason: "because" })),
  } as unknown as JudgePort;
}

function deadJudge(family: string): JudgePort {
  return {
    family,
    review: (): Promise<never> => Promise.reject(new Error("unreachable")),
  };
}

const placeholder: ReviewFinding = {
  engine: "gitleaks",
  ruleId: "telegram-bot-api-token",
  path: ".env.example",
  startLine: 3,
  entropy: 3.2,
  contextLines: ["", "", "TELEGRAM_BOT_TOKEN=REDACTED"],
};

const real: ReviewFinding = {
  engine: "gitleaks",
  ruleId: "generic-api-key",
  path: "infrastructure/k8s/secrets.yaml",
  startLine: 14,
  entropy: 4.6,
  contextLines: ["data:", "  JWT_SECRET: REDACTED"],
};

const packet: BrokerResultPacket = {
  schemaVersion: 1,
  groups: [
    { token: 10, bucket: 1 },
    { token: 20, bucket: 1 },
  ],
} as unknown as BrokerResultPacket;

const tokenOf = (ruleId: string): number | null =>
  ruleId === "telegram-bot-api-token"
    ? 10
    : ruleId === "generic-api-key"
      ? 20
      : null;

describe("review prompt", () => {
  it("shows the path and numbered lines the verdict depends on", () => {
    const prompt = renderFindingReviewPrompt(placeholder);
    expect(prompt).toContain(".env.example");
    expect(prompt).toContain("5| TELEGRAM_BOT_TOKEN=REDACTED");
  });

  it("carries no secret value, only the redaction marker", () => {
    expect(renderFindingReviewPrompt(placeholder)).not.toMatch(/sk_live|AKIA/);
  });
});

describe("council review of scanner findings", () => {
  it("refuses a council of one", async () => {
    await expect(
      reviewScannerFindings([placeholder], [judge("a", "not_real")], true),
    ).rejects.toThrow(/at least two judges/);
  });

  it("refuses two judges from the same family", async () => {
    await expect(
      reviewScannerFindings(
        [placeholder],
        [judge("a", "not_real"), judge("a", "not_real")],
        true,
      ),
    ).rejects.toThrow(/distinct model families/);
  });

  it("suppresses only on a unanimous rejection", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder],
      [judge("a", "not_real"), judge("b", "not_real")],
      true,
    );
    expect(outcome.suppressedRuleIds).toEqual(["telegram-bot-api-token"]);
  });

  it("keeps the finding when judges disagree", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder],
      [judge("a", "not_real"), judge("b", "real")],
      true,
    );
    expect(outcome.suppressedRuleIds).toEqual([]);
  });

  it("treats unsure as keep", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder],
      [judge("a", "not_real"), judge("b", "unsure")],
      true,
    );
    expect(outcome.suppressedRuleIds).toEqual([]);
  });

  it("keeps everything when a judge is unreachable", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder],
      [judge("a", "not_real"), deadJudge("b")],
      true,
    );
    expect(outcome.suppressedRuleIds).toEqual([]);
    expect(outcome.complete).toBe(false);
  });

  it("keeps a rule when any one of its occurrences survives", async () => {
    const second: ReviewFinding = { ...placeholder, startLine: 40 };
    const judges = [
      {
        family: "a",
        review: vi
          .fn()
          .mockResolvedValueOnce({ verdict: "not_real", reason: "example" })
          .mockResolvedValueOnce({ verdict: "real", reason: "looks live" }),
      },
      {
        family: "b",
        review: vi.fn(() =>
          Promise.resolve({ verdict: "not_real", reason: "example" }),
        ),
      },
    ] as unknown as JudgePort[];
    const outcome = await reviewScannerFindings(
      [placeholder, second],
      judges,
      true,
    );
    expect(outcome.suppressedRuleIds).toEqual([]);
  });

  it("counts every judge call for the budget ledger", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder, real],
      [judge("a", "real"), judge("b", "real")],
      true,
    );
    expect(outcome.requestsSpent).toBe(4);
  });
});

describe("applying suppression to a packet", () => {
  it("removes only the unanimously rejected group", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder, real],
      [
        {
          family: "a",
          review: vi
            .fn()
            .mockResolvedValueOnce({ verdict: "not_real", reason: "example" })
            .mockResolvedValueOnce({ verdict: "real", reason: "manifest" }),
        },
        {
          family: "b",
          review: vi
            .fn()
            .mockResolvedValueOnce({ verdict: "not_real", reason: "example" })
            .mockResolvedValueOnce({ verdict: "real", reason: "manifest" }),
        },
      ],
      true,
    );
    const applied = applySuppression(packet, outcome, tokenOf);
    expect(applied.removedGroups).toBe(1);
    expect(applied.packet.groups.map((g) => g.token)).toEqual([20]);
  });

  it("changes nothing when the review was incomplete", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder],
      [judge("a", "not_real"), judge("b", "not_real")],
      false,
    );
    expect(outcome.suppressedRuleIds).toEqual(["telegram-bot-api-token"]);
    // Suppression is still refused: coarse buckets cannot be partly reduced.
    expect(applySuppression(packet, outcome, tokenOf).removedGroups).toBe(0);
  });

  it("leaves a rule alone when its token cannot be resolved", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder],
      [judge("a", "not_real"), judge("b", "not_real")],
      true,
    );
    expect(applySuppression(packet, outcome, () => null).removedGroups).toBe(0);
  });

  it("does nothing when nothing was rejected", async () => {
    const outcome = await reviewScannerFindings(
      [placeholder],
      [judge("a", "real"), judge("b", "real")],
      true,
    );
    expect(applySuppression(packet, outcome, tokenOf).packet).toBe(packet);
  });
});
