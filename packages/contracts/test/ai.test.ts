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
  it("accepts only the fixture provider tag", () => {
    expect(aiProviderTagSchema.safeParse(FIXTURE_PROVIDER).success).toBe(true);
    for (const real of ["groq", "cloudflare", "gemini", "openai", "", "FIXTURE"]) {
      expect(aiProviderTagSchema.safeParse(real).success).toBe(false);
    }
  });

  it("defaults to disabled and offers only disabled/fixture modes", () => {
    expect(DEFAULT_AI_MODE).toBe("disabled");
    expect(AI_MODES).toEqual(["disabled", "fixture"]);
    expect(aiModeSchema.safeParse("production").success).toBe(false);
    expect(aiModeSchema.safeParse("live").success).toBe(false);
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
