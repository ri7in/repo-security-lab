import { describe, expect, it } from "vitest";
import {
  AiFixtureCoordinator,
  DeterministicFixtureJudge,
  DeterministicFixtureScout,
  GroundingValidator,
  registerModelAdapter,
} from "@app/ai";
import type { AiCandidate } from "@app/contracts";

const candidate: AiCandidate = {
  provider: "fixture",
  fixtureId: "fixture-001",
  candidateId: "candidate-001",
  cwe: "CWE-78",
  fileToken: 7,
  lineStart: 1,
  lineEnd: 2,
  evidenceQuote: "execute(userInput)",
  sourceSymbol: 10,
  sinkSymbol: 20,
  traceEdges: [30],
  attackPreconditions: ["remote-input"],
  impact: "code-execution",
  confidence: "high",
  missingEvidence: [],
};

const pack = {
  fixtureId: "fixture-001",
  files: [
    {
      fileToken: 7,
      lines: ["const userInput = request.body;", "execute(userInput);"],
      symbolIds: new Set([10, 20]),
      traceEdgeIds: new Set([30]),
    },
  ],
} as const;

describe("inert AI fixture lane", () => {
  it("grounds exact line, quote, symbol, and trace evidence", () => {
    const validator = new GroundingValidator();
    expect(validator.validate(candidate, pack)).toEqual(candidate);
    expect(
      validator.validate({ ...candidate, evidenceQuote: "invented()" }, pack),
    ).toBeNull();
    expect(
      validator.validate({ ...candidate, traceEdges: [999] }, pack),
    ).toBeNull();
  });

  it("defaults to disabled and never calls fixture models", async () => {
    let called = false;
    const scout = {
      family: "fixture-a",
      analyze() {
        called = true;
        return Promise.resolve([candidate]);
      },
    };
    const result = await new AiFixtureCoordinator({
      scouts: [scout, { ...scout, family: "fixture-b" }],
      judge: new DeterministicFixtureJudge(new Set(["candidate-001"])),
    }).run(pack);
    expect(result).toEqual({ state: "ai_not_run", groundedCandidates: [] });
    expect(called).toBe(false);
  });

  it("runs two blind distinct fixture families and grounds before judging", async () => {
    const coordinator = new AiFixtureCoordinator({
      mode: "fixture",
      scouts: [
        new DeterministicFixtureScout("fixture-a", [candidate]),
        new DeterministicFixtureScout("fixture-b", [
          { ...candidate, candidateId: "candidate-bad", evidenceQuote: "fake" },
        ]),
      ],
      judge: new DeterministicFixtureJudge(new Set(["candidate-001"])),
    });
    expect(await coordinator.run(pack)).toEqual({
      state: "ai_partial",
      groundedCandidates: [candidate],
    });
  });

  it("cannot register a real provider adapter", () => {
    expect(() => registerModelAdapter({ provider: "gemini" })).toThrow(
      "real model adapters are disabled in this slice",
    );
  });

  it("never lets the judge invent, modify, or duplicate a grounded candidate", async () => {
    const coordinator = new AiFixtureCoordinator({
      mode: "fixture",
      scouts: [
        new DeterministicFixtureScout("fixture-a", [candidate]),
        new DeterministicFixtureScout("fixture-b", []),
      ],
      judge: {
        review: () =>
          Promise.resolve([
            candidate,
            candidate,
            { ...candidate, impact: "data-disclosure" },
            { ...candidate, candidateId: "candidate-invented" },
          ]),
      },
    });
    expect((await coordinator.run(pack)).groundedCandidates).toEqual([candidate]);
  });

  it("drops a candidate id when blind scouts attach conflicting evidence", async () => {
    const coordinator = new AiFixtureCoordinator({
      mode: "fixture",
      scouts: [
        new DeterministicFixtureScout("fixture-a", [candidate]),
        new DeterministicFixtureScout("fixture-b", [
          { ...candidate, confidence: "medium" },
        ]),
      ],
      judge: new DeterministicFixtureJudge(new Set([candidate.candidateId])),
    });
    expect((await coordinator.run(pack)).groundedCandidates).toEqual([]);
  });
});
