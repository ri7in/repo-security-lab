import { describe, expect, it } from "vitest";
import {
  COUNCIL,
  DEEP_READ_REPO_LIMIT,
  GEMINI_FLASH_LITE,
  GROQ_GPT_OSS,
  MODELED_TOKENS_PER_REPO,
  OPENROUTER_NEMOTRON,
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
    expect(isVerified(GROQ_GPT_OSS)).toBe(true);
    expect(isVerified(GEMINI_FLASH_LITE)).toBe(false);
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
    const capacity = modelCapacity(GROQ_GPT_OSS);
    // 200,000 tokens/day over 12,000 tokens/repo.
    expect(capacity.deepReadsPerDay).toBe(16);
    expect(capacity.percentRemaining).toBe(100);
  });

  it("bounds a model with no daily token cap by its request allowance", () => {
    const capacity = modelCapacity(OPENROUTER_NEMOTRON);
    // OpenRouter meters free requests rather than tokens: 50 a day over one
    // request per repository.
    expect(capacity.deepReadsPerDay).toBe(50);
  });

  it("gives a model with no published allowance no capacity at all", () => {
    // Gemini's limits are not published per model any more, so the entry
    // carries no number to spend. Zero is the fail-closed answer; any other
    // figure would be invented, and this meter is read by people deciding
    // whether to wait.
    expect(modelCapacity(GEMINI_FLASH_LITE).deepReadsPerDay).toBe(0);
    expect(isVerified(GEMINI_FLASH_LITE)).toBe(false);
  });

  it("keeps every council member to a limit somebody actually read", () => {
    // The budget was once computed from a reader OpenRouter had removed and a
    // judge the worker never called, so the figure on the landing page was
    // arithmetic about models that were not doing the work.
    expect(COUNCIL.every(isVerified)).toBe(true);
    expect(councilBudget().limitsVerified).toBe(true);
  });

  it("reports a partial day as a share of that model's own day", () => {
    const spend: ModelSpend = { tokens: 100_000, requests: 32 };
    expect(modelCapacity(GROQ_GPT_OSS, spend).percentRemaining).toBe(50);
  });

  it("clamps an overspent model to zero rather than a negative share", () => {
    const spend: ModelSpend = { tokens: 999_999, requests: 9_999 };
    const capacity = modelCapacity(GROQ_GPT_OSS, spend);
    expect(capacity.deepReadsRemaining).toBe(0);
    expect(capacity.percentRemaining).toBe(0);
  });

  it("ignores negative spend instead of inventing extra capacity", () => {
    const capacity = modelCapacity(GROQ_GPT_OSS, { tokens: -50_000, requests: -5 });
    expect(capacity.deepReadsRemaining).toBe(capacity.deepReadsPerDay);
  });
});

describe("council budget", () => {
  it("reports the scarcest member, not the most generous", () => {
    const budget = councilBudget();
    expect(budget.scarcestModelId).toBe(GROQ_GPT_OSS.id);
    expect(budget.deepReadsPerDay).toBe(16);
    expect(budget.percentRemaining).toBe(100);
    expect(budget.available).toBe(true);
  });

  it("shows the scout is not the bottleneck: it outlasts the judges", () => {
    const scout = modelCapacity(OPENROUTER_NEMOTRON);
    const judgePool = modelCapacity(GROQ_GPT_OSS);
    expect(scout.deepReadsPerDay).toBeGreaterThan(judgePool.deepReadsPerDay);
  });

  it("caps a single request at three repositories", () => {
    expect(councilBudget().repoLimitPerRequest).toBe(3);
    expect(DEEP_READ_REPO_LIMIT).toBe(3);
  });

  it("falls to the scarcest share when one judge is half spent", () => {
    const budget = councilBudget(
      new Map([[GROQ_GPT_OSS.id, { tokens: 150_000, requests: 48 }]]),
    );
    expect(budget.scarcestModelId).toBe(GROQ_GPT_OSS.id);
    expect(budget.percentRemaining).toBe(25);
    expect(budget.deepReadsRemaining).toBe(4);
  });

  it("goes unavailable when any single member is exhausted", () => {
    const budget = councilBudget(
      new Map([[GROQ_GPT_OSS.id, { tokens: 200_000, requests: 64 }]]),
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
      councilBudget(new Map(), [GEMINI_FLASH_LITE, GROQ_GPT_OSS]).limitsVerified,
    ).toBe(false);
  });

  it("reports verified when every member has a dated primary source", () => {
    expect(councilBudget(new Map(), [GROQ_GPT_OSS]).limitsVerified).toBe(true);
  });
});

describe("public disclosure", () => {
  it("names every routing surface that receives source, deduplicated", () => {
    expect(councilBudget().providers).toEqual(["openrouter", "groq", "gemini"]);
  });

  it("still names every provider that can receive code with no council", () => {
    // The disclosure is not the budget. A provider being unbudgetable, which
    // is why Gemini is out of COUNCIL, is not a reason to leave it out of the
    // sentence that tells people where their code goes.
    expect(councilBudget(new Map(), []).providers).toEqual([
      "openrouter",
      "groq",
      "gemini",
    ]);
  });

  it("discloses Google, which is not budgeted and does receive code", () => {
    expect(councilBudget().providers).toContain("gemini");
    expect(COUNCIL.some((model) => model.provider === "gemini")).toBe(false);
  });
});
