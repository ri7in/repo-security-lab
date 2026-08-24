import { describe, expect, it } from "vitest";
import { REVIEW_SYSTEM_PROMPT, renderFindingReviewPrompt } from "@app/ai";
import type { ReviewFinding } from "@app/contracts";
import { ChatJudge } from "../src/index.js";

/**
 * Live judge proof. Skipped unless RUN_LIVE_JUDGES=1 and keys are present.
 *
 * This exists because the judge panel depends on things no unit test can see:
 * whether a free model id still exists, whether the provider still answers,
 * and whether the model still returns parseable JSON. Free model ids churn
 * within weeks, so this is the test that tells you the panel has rotted.
 *
 * It asserts BOTH directions on purpose. A judge that calls everything
 * not_real would delete real findings, which is far worse than showing a
 * false one, so "says real for a real secret" is the assertion that matters
 * most here.
 */

const enabled = process.env["RUN_LIVE_JUDGES"] === "1";

const PANEL = [
  {
    family: "groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    keyName: "GROQ_API_KEY",
    model: process.env["GROQ_JUDGE_MODEL"] ?? "openai/gpt-oss-120b",
  },
  {
    family: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    keyName: "OPENROUTER_API_KEY",
    model:
      process.env["OPENROUTER_JUDGE_MODEL"] ??
      "nvidia/nemotron-3-ultra-550b-a55b:free",
  },
  {
    family: "google",
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    keyName: "GEMINI_API_KEY",
    model: process.env["GEMINI_JUDGE_MODEL"] ?? "gemini-flash-lite-latest",
  },
] as const;

function finding(
  overrides: Partial<ReviewFinding> & Pick<ReviewFinding, "path">,
): ReviewFinding {
  return {
    engine: "gitleaks",
    ruleId: "generic-api-key",
    startLine: 14,
    entropy: 4.2,
    fileLineCount: 40,
    valueLength: 43,
    valueHints: [],
    contextStartLine: 13,
    contextLines: ["data:", "  JWT_SECRET: REDACTED"],
    ...overrides,
  };
}

const REAL = finding({ path: "infrastructure/k8s/secrets.yaml" });
const PLACEHOLDER = finding({
  path: ".env.example",
  ruleId: "telegram-bot-api-token",
  startLine: 101,
  entropy: 3.2,
  fileLineCount: 120,
  valueLength: 46,
  valueHints: ["placeholder"],
  contextStartLine: 101,
  contextLines: ["TELEGRAM_BOT_TOKEN=REDACTED"],
});

describe.skipIf(!enabled)("live judge panel", () => {
  for (const member of PANEL) {
    const key = process.env[member.keyName] ?? "";

    it.skipIf(key === "")(
      `${member.family} keeps a credential in a deployment manifest`,
      async () => {
        const judge = new ChatJudge({
          apiKey: key,
          model: member.model,
          family: member.family,
          endpoint: member.endpoint,
          fetch: (input, init) => fetch(input, init),
        });
        const verdict = await judge.review(
          REVIEW_SYSTEM_PROMPT,
          renderFindingReviewPrompt(REAL),
        );
        // "unsure" is acceptable: it keeps the finding. "not_real" is not.
        expect(verdict.verdict).not.toBe("not_real");
      },
      120_000,
    );

    it.skipIf(key === "")(
      `${member.family} recognises a documentation placeholder`,
      async () => {
        const judge = new ChatJudge({
          apiKey: key,
          model: member.model,
          family: member.family,
          endpoint: member.endpoint,
          fetch: (input, init) => fetch(input, init),
        });
        const verdict = await judge.review(
          REVIEW_SYSTEM_PROMPT,
          renderFindingReviewPrompt(PLACEHOLDER),
        );
        expect(verdict.verdict).toBe("not_real");
      },
      120_000,
    );
  }
});
