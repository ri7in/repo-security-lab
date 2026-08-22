import { describe, expect, it } from "vitest";
import {
  COUNCIL,
  DEEP_READ_REPO_LIMIT,
  GEMINI_FLASH,
  GROQ_QWEN,
  MODELED_TOKENS_PER_REPO,
  OPENROUTER_QWEN_CODER,
  councilBudget,
  isVerified,
  modelCapacity,
  type ModelSpend,
} from "../src/index.js";

describe("model allowances", () => {
  it("keeps a source and a verification date on every model", () => {
    for (const model of COUNCIL) {
      expect(model.sourceUrl).toMatch(/^https:\/\//);
      expect(model.verifiedOn.length).toBeGreaterThan(0);
    }
  });

  it("marks the Gemini limits as unconfirmed until AI Studio is read", () => {
    expect(isVerified(GROQ_QWEN)).toBe(true);
    expect(isVerified(GEMINI_FLASH)).toBe(false);
  });

  it("never lets a Groq free model act as a reader", () => {
    // 8,000 tokens/minute cannot carry a 90,000-token repository.
    for (const model of COUNCIL.filter((entry) => entry.provider === "groq")) {
      expect(model.role).toBe("judge");
      expect(model.tokensPerMinute).toBeLessThan(
        MODELED_TOKENS_PER_REPO.reader,
      );
    }
  });

  it("only registers a reader that can hold a whole account at once", () => {
    // The operator's own account measured 586k tokens of source on
    // 2026-08-21. A reader must clear that with headroom, and any published
    // per-minute limit must not undercut its own context window.
    const WHOLE_ACCOUNT_TOKENS = 586_200;
    for (const model of COUNCIL.filter((entry) => entry.role === "reader")) {
      expect(model.contextWindow).toBeGreaterThan(WHOLE_ACCOUNT_TOKENS);
      if (model.tokensPerMinute !== null) {
        expect(model.tokensPerMinute).toBeGreaterThanOrEqual(
          MODELED_TOKENS_PER_REPO.reader,
        );
      }
    }
  });

  it("keeps every judge below a whole-repository prompt, which is why they judge", () => {
    for (const model of COUNCIL.filter((entry) => entry.role === "judge")) {
      expect(model.tokensPerMinute).not.toBeNull();
      expect(model.tokensPerMinute ?? 0).toBeLessThan(
        MODELED_TOKENS_PER_REPO.reader,
      );
    }
  });
});

describe("model capacity", () => {
  it("bounds a token-capped judge by its daily token allowance", () => {
    const capacity = modelCapacity(GROQ_QWEN);
    // 200,000 tokens/day over 12,000 tokens/repo.
    expect(capacity.deepReadsPerDay).toBe(16);
    expect(capacity.percentRemaining).toBe(100);
  });

  it("bounds a model with no daily token cap by its request allowance", () => {
    const capacity = modelCapacity(GEMINI_FLASH);
    // 1,500 requests/day over 1 request/repo.
    expect(capacity.deepReadsPerDay).toBe(1_500);
  });

  it("reports a partial day as a share of that model's own day", () => {
    const spend: ModelSpend = { tokens: 100_000, requests: 32 };
    expect(modelCapacity(GROQ_QWEN, spend).percentRemaining).toBe(50);
  });

  it("clamps an overspent model to zero rather than a negative share", () => {
    const spend: ModelSpend = { tokens: 999_999, requests: 9_999 };
    const capacity = modelCapacity(GROQ_QWEN, spend);
    expect(capacity.deepReadsRemaining).toBe(0);
    expect(capacity.percentRemaining).toBe(0);
  });

  it("ignores negative spend instead of inventing extra capacity", () => {
    const capacity = modelCapacity(GROQ_QWEN, { tokens: -50_000, requests: -5 });
    expect(capacity.deepReadsRemaining).toBe(capacity.deepReadsPerDay);
  });
});

describe("council budget", () => {
  it("reports the scarcest member, not the most generous", () => {
    const budget = councilBudget();
    expect(budget.scarcestModelId).toBe(GROQ_QWEN.id);
    expect(budget.deepReadsPerDay).toBe(16);
    expect(budget.percentRemaining).toBe(100);
    expect(budget.available).toBe(true);
  });

  it("shows the scout is not the bottleneck: it outlasts the judges", () => {
    const scout = modelCapacity(OPENROUTER_QWEN_CODER);
    const judgePool = modelCapacity(GROQ_QWEN);
    expect(scout.deepReadsPerDay).toBeGreaterThan(judgePool.deepReadsPerDay);
  });

  it("caps a single request at three repositories", () => {
    expect(councilBudget().repoLimitPerRequest).toBe(3);
    expect(DEEP_READ_REPO_LIMIT).toBe(3);
  });

  it("falls to the scarcest share when one judge is half spent", () => {
    const budget = councilBudget(
      new Map([[GROQ_QWEN.id, { tokens: 150_000, requests: 48 }]]),
    );
    expect(budget.scarcestModelId).toBe(GROQ_QWEN.id);
    expect(budget.percentRemaining).toBe(25);
    expect(budget.deepReadsRemaining).toBe(4);
  });

  it("goes unavailable when any single member is exhausted", () => {
    const budget = councilBudget(
      new Map([[GROQ_QWEN.id, { tokens: 200_000, requests: 64 }]]),
    );
    expect(budget.available).toBe(false);
    expect(budget.percentRemaining).toBe(0);
    expect(budget.deepReadsRemaining).toBe(0);
  });

  it("treats an unrecorded model as unused rather than failing", () => {
    const budget = councilBudget(new Map([["unknown/model", { tokens: 1, requests: 1 }]]));
    expect(budget.percentRemaining).toBe(100);
  });

  it("is unavailable with no council configured", () => {
    const budget = councilBudget(new Map(), []);
    expect(budget.available).toBe(false);
    expect(budget.scarcestModelId).toBe("none");
  });
});

describe("limit verification", () => {
  it("reports the default council as verified now that every member has a dated source", () => {
    expect(councilBudget().limitsVerified).toBe(true);
  });

  it("reports unverified the moment an unconfirmed model joins", () => {
    expect(
      councilBudget(new Map(), [GEMINI_FLASH, GROQ_QWEN]).limitsVerified,
    ).toBe(false);
  });

  it("reports verified when every member has a dated primary source", () => {
    expect(councilBudget(new Map(), [GROQ_QWEN]).limitsVerified).toBe(true);
  });
});

describe("public disclosure", () => {
  it("names every routing surface that receives source, deduplicated", () => {
    expect(councilBudget().providers).toEqual(["openrouter", "groq"]);
  });

  it("names nothing when no council is configured", () => {
    expect(councilBudget(new Map(), []).providers).toEqual([]);
  });
});
