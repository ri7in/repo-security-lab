import {
  DEFAULT_AI_MODE,
  aiCandidateSchema,
  aiModeSchema,
  type AiCandidate,
  type AiMode,
} from "@app/contracts";

export interface SanitizedFixtureFile {
  readonly fileToken: number;
  readonly lines: readonly string[];
  readonly symbolIds: ReadonlySet<number>;
  readonly traceEdgeIds: ReadonlySet<number>;
}

export interface SanitizedFixturePack {
  readonly fixtureId: string;
  readonly files: readonly SanitizedFixtureFile[];
}

export interface FixtureScout {
  readonly family: string;
  analyze(pack: SanitizedFixturePack): Promise<readonly AiCandidate[]>;
}

export interface FixtureJudge {
  review(candidates: readonly AiCandidate[]): Promise<readonly AiCandidate[]>;
}

export interface AiFixtureRun {
  readonly state: "ai_not_run" | "ai_partial";
  readonly groundedCandidates: readonly AiCandidate[];
}

export class GroundingValidator {
  validate(
    candidateInput: unknown,
    pack: SanitizedFixturePack,
  ): AiCandidate | null {
    const parsed = aiCandidateSchema.safeParse(candidateInput);
    if (!parsed.success || parsed.data.fixtureId !== pack.fixtureId) return null;
    const candidate = parsed.data;
    const file = pack.files.find(
      (entry) => entry.fileToken === candidate.fileToken,
    );
    if (
      file === undefined ||
      candidate.lineEnd < candidate.lineStart ||
      candidate.lineEnd > file.lines.length ||
      !file.symbolIds.has(candidate.sourceSymbol) ||
      !file.symbolIds.has(candidate.sinkSymbol) ||
      candidate.traceEdges.some((edge) => !file.traceEdgeIds.has(edge))
    ) {
      return null;
    }
    const exactSlice = file.lines
      .slice(candidate.lineStart - 1, candidate.lineEnd)
      .join("\n");
    return exactSlice.includes(candidate.evidenceQuote) ? candidate : null;
  }
}

export class DeterministicFixtureScout implements FixtureScout {
  readonly family: string;
  readonly #candidates: readonly unknown[];

  constructor(family: string, candidates: readonly unknown[]) {
    this.family = family;
    this.#candidates = candidates;
  }

  analyze(): Promise<readonly AiCandidate[]> {
    return Promise.resolve(
      this.#candidates.map((candidate) => aiCandidateSchema.parse(candidate)),
    );
  }
}

export class DeterministicFixtureJudge implements FixtureJudge {
  readonly #acceptedCandidateIds: ReadonlySet<string>;

  constructor(acceptedCandidateIds: ReadonlySet<string>) {
    this.#acceptedCandidateIds = acceptedCandidateIds;
  }

  review(candidates: readonly AiCandidate[]): Promise<readonly AiCandidate[]> {
    return Promise.resolve(
      candidates.filter((candidate) =>
        this.#acceptedCandidateIds.has(candidate.candidateId),
      ),
    );
  }
}

export class AiFixtureCoordinator {
  readonly #mode: AiMode;
  readonly #scouts: readonly [FixtureScout, FixtureScout];
  readonly #judge: FixtureJudge;
  readonly #grounding = new GroundingValidator();

  constructor(options: {
    readonly mode?: AiMode;
    readonly scouts: readonly [FixtureScout, FixtureScout];
    readonly judge: FixtureJudge;
  }) {
    this.#mode = options.mode ?? DEFAULT_AI_MODE;
    if (!aiModeSchema.safeParse(this.#mode).success) {
      throw new Error("invalid AI mode");
    }
    if (options.scouts[0].family === options.scouts[1].family) {
      throw new Error("fixture scouts must use distinct families");
    }
    this.#scouts = options.scouts;
    this.#judge = options.judge;
  }

  async run(pack: SanitizedFixturePack): Promise<AiFixtureRun> {
    if (this.#mode === "disabled") {
      return { state: "ai_not_run", groundedCandidates: [] };
    }
    const blindResults = await Promise.all(
      this.#scouts.map((scout) => scout.analyze(pack)),
    );
    const grounded = blindResults
      .flat()
      .map((candidate) => this.#grounding.validate(candidate, pack))
      .filter((candidate): candidate is AiCandidate => candidate !== null);
    const uniqueGrounded = new Map<string, AiCandidate>();
    const conflictedIds = new Set<string>();
    for (const candidate of grounded) {
      const existing = uniqueGrounded.get(candidate.candidateId);
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(candidate)
      ) {
        conflictedIds.add(candidate.candidateId);
      } else if (existing === undefined) {
        uniqueGrounded.set(candidate.candidateId, candidate);
      }
    }
    for (const candidateId of conflictedIds) uniqueGrounded.delete(candidateId);
    const groundedCandidates = [...uniqueGrounded.values()];
    const reviewed = await this.#judge.review(groundedCandidates);
    const accepted = new Map<string, AiCandidate>();
    for (const candidateInput of reviewed) {
      const parsed = aiCandidateSchema.safeParse(candidateInput);
      if (!parsed.success) continue;
      const original = uniqueGrounded.get(parsed.data.candidateId);
      if (
        original !== undefined &&
        JSON.stringify(original) === JSON.stringify(parsed.data)
      ) {
        accepted.set(parsed.data.candidateId, original);
      }
    }
    return {
      state: "ai_partial",
      groundedCandidates: [...accepted.values()],
    };
  }
}

/** Runtime guard: the private slice has no real network adapter vocabulary. */
export function registerModelAdapter(adapter: { readonly provider: string }): never {
  void adapter;
  throw new Error("real model adapters are disabled in this slice");
}
