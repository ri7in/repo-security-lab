import { describe, expect, it } from "vitest";
import {
  AI_MODES,
  DEFAULT_AI_MODE,
  FIXTURE_PROVIDER,
  REVIEW_TIERS,
  aiFixtureArtifactTagSchema,
  aiModeSchema,
  aiProviderTagSchema,
  providerPolicySchema,
} from "@app/contracts";

describe("ai provider tagging", () => {
  it("keeps the provider vocabulary closed to the routing surfaces we vetted", () => {
    expect(aiProviderTagSchema.safeParse(FIXTURE_PROVIDER).success).toBe(true);
    for (const vetted of ["openrouter", "groq", "gemini"]) {
      expect(aiProviderTagSchema.safeParse(vetted).success).toBe(true);
    }
    for (const unvetted of ["cloudflare", "openai", "anthropic", "", "FIXTURE"]) {
      expect(aiProviderTagSchema.safeParse(unvetted).success).toBe(false);
    }
  });

  it("still defaults to disabled now that a live mode exists", () => {
    expect(DEFAULT_AI_MODE).toBe("disabled");
    expect(AI_MODES).toEqual(["disabled", "fixture", "live"]);
    expect(aiModeSchema.safeParse("production").success).toBe(false);
    expect(aiModeSchema.safeParse("").success).toBe(false);
  });

  it("tags every fixture artifact so it cannot pass as real review", () => {
    expect(
      aiFixtureArtifactTagSchema.safeParse({
        provider: "fixture",
        fixtureId: "scout-a-reply-001",
      }).success,
    ).toBe(true);
    expect(
      aiFixtureArtifactTagSchema.safeParse({
        provider: "groq",
        fixtureId: "scout-a-reply-001",
      }).success,
    ).toBe(false);
    expect(
      aiFixtureArtifactTagSchema.safeParse({
        provider: "fixture",
        fixtureId: "scout-a-reply-001",
        model: "real-model-name",
      }).success,
    ).toBe(false);
  });
});

describe("review tiers", () => {
  it("matches the accepted publication tiers exactly", () => {
    expect(REVIEW_TIERS).toEqual([
      "deterministic",
      "ai_confirmed",
      "ai_probable",
      "needs_human_review",
      "rejected",
    ]);
  });
});

describe("provider policy", () => {
  it("accepts a typed policy and rejects free-form fields", () => {
    expect(
      providerPolicySchema.safeParse({
        family: "qwen",
        zdrRequired: true,
        termsVersion: "2026-08-16",
      }).success,
    ).toBe(true);
    expect(
      providerPolicySchema.safeParse({
        family: "qwen",
        zdrRequired: true,
        termsVersion: "2026-08-16",
        apiKey: "gsk_live_secret",
      }).success,
    ).toBe(false);
    expect(
      providerPolicySchema.safeParse({
        family: "a family with spaces",
        zdrRequired: false,
        termsVersion: "1",
      }).success,
    ).toBe(false);
  });
});
