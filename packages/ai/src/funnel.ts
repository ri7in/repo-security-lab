import type { AiJudgeVerdict, AiLaneState, ReviewTier } from "@app/contracts";
import { groundScoutFlags, type GroundedFlag, type GroundingRejection } from "./grounding.js";
import { renderScoutPack, type ScoutPack } from "./pack.js";
import {
  JUDGE_SYSTEM_PROMPT,
  SCOUT_SYSTEM_PROMPT,
  renderJudgeUserPrompt,
  renderScoutUserPrompt,
} from "./prompts.js";
import type { JudgePort, ScoutPort } from "./ports.js";

/**
 * The two-pass funnel.
 *
 * Pass 1 reads an entire account in one request and points at code. Pass 2
 * sends each grounded pointer to independent judges from different model
 * families. Between them sits a deterministic grounding gate that no model
 * participates in.
 *
 * Standing guarantees, enforced here rather than documented elsewhere:
 *
 * 1. AI output is additive. This module never receives, edits, or suppresses a
 *    deterministic finding. Gitleaks results are assembled on a separate path.
 * 2. A flag is published only if it is grounded AND a majority of the judges
 *    that answered say "real". "unsure" counts against publication, and a
 *    panel shorter than configured marks the whole lane partial.
 * 3. Judges must come from distinct model families. Two judges from one family
 *    agreeing is one opinion, not a consensus, and the constructor refuses it.
 * 4. Every failure produces an explicit lane state. A broken scout reports
 *    `ai_not_run`; a partly judged batch reports `ai_partial`. Neither is ever
 *    reported as a clean `ai_complete`.
 */

export interface JudgedFlag {
  readonly grounded: GroundedFlag;
  readonly verdicts: readonly {
    readonly family: string;
    readonly verdict: AiJudgeVerdict["verdict"];
    readonly reason: string;
  }[];
  readonly tier: ReviewTier;
}

export interface FunnelResult {
  readonly state: AiLaneState;
  /** Only flags that earned publication. */
  readonly published: readonly JudgedFlag[];
  /** Everything judged, including rejections, for honest telemetry. */
  readonly judged: readonly JudgedFlag[];
  readonly groundingRejections: readonly {
    readonly reason: GroundingRejection;
    readonly fileToken: number | null;
  }[];
  /** Requests actually spent, for the daily budget ledger. */
  readonly requestsSpent: number;
  /**
   * Grounded flags the judge cap left unjudged.
   *
   * Reported rather than dropped in silence: a capped review is not a clean
   * one, and a caller that cannot tell the difference will publish the second
   * as though it were the first.
   */
  readonly unjudged: number;
  readonly failure: string | null;
}

function tierFor(
  verdicts: readonly { readonly verdict: AiJudgeVerdict["verdict"] }[],
): ReviewTier {
  const real = verdicts.filter((entry) => entry.verdict === "real").length;
  const notReal = verdicts.filter((entry) => entry.verdict === "not_real").length;
  if (real === verdicts.length && real > 0) return "ai_confirmed";
  // A strict majority of ALL judges, not merely more "real" than "not_real".
  // With two judges the old comparison published on one "real" and one
  // "unsure", because 1 > 0, which contradicted this module's own rule that
  // "unsure" counts against publication. An abstention is not a vote in
  // favour.
  if (real * 2 > verdicts.length) return "ai_probable";
  if (real === 0 && notReal === verdicts.length) return "rejected";
  return "needs_human_review";
}

/** Tiers that may appear in a user-facing report. */
const PUBLISHABLE: ReadonlySet<ReviewTier> = new Set<ReviewTier>([
  "ai_confirmed",
  "ai_probable",
]);

export interface FunnelOptions {
  readonly scout: ScoutPort;
  readonly judges: readonly JudgePort[];
  /** Hard ceiling on judge calls, so one noisy scout cannot drain the day. */
  readonly maxJudgedFlags?: number;
}

export class DetectionFunnel {
  readonly #scout: ScoutPort;
  readonly #judges: readonly JudgePort[];
  readonly #maxJudged: number;

  constructor(options: FunnelOptions) {
    if (options.judges.length < 2) {
      throw new Error("the council needs at least two judges");
    }
    const families = new Set(options.judges.map((judge) => judge.family));
    if (families.size !== options.judges.length) {
      throw new Error("judges must come from distinct model families");
    }
    this.#scout = options.scout;
    this.#judges = options.judges;
    this.#maxJudged = options.maxJudgedFlags ?? 20;
  }

  async run(pack: ScoutPack): Promise<FunnelResult> {
    if (pack.files.length === 0) {
      return {
        state: "ai_not_run",
        published: [],
        judged: [],
        groundingRejections: [],
        requestsSpent: 0,
        unjudged: 0,
        failure: "empty pack",
      };
    }

    let scouted;
    try {
      scouted = await this.#scout.analyze({
        systemPrompt: SCOUT_SYSTEM_PROMPT,
        userPrompt: renderScoutUserPrompt(renderScoutPack(pack)),
      });
    } catch (error: unknown) {
      // The port contract carries a `kind` on provider errors. Reading it
      // defensively keeps this module free of any provider import.
      const kind = (error as { kind?: unknown } | null)?.kind;
      return {
        state: "ai_not_run",
        published: [],
        judged: [],
        groundingRejections: [],
        requestsSpent: 1,
        unjudged: 0,
        failure: typeof kind === "string" ? `scout ${kind}` : "scout failed",
      };
    }

    const { grounded, rejected } = groundScoutFlags(scouted.flags, pack);

    // Ordered by location, never by the model's own confidence.
    //
    // Sorting on a scout-supplied field handed the scout control of the cap:
    // mark noise "high", mark a real finding "low", and the real one falls off
    // the end unjudged. Position in a file is not something the model chooses,
    // so the queue is now data-ordered and the cap bites arbitrarily rather
    // than exactly where a misbehaving scout would want it to.
    const queue = [...grounded]
      .sort(
        (left, right) =>
          left.file.fileToken - right.file.fileToken ||
          left.flag.lineStart - right.flag.lineStart,
      )
      .slice(0, this.#maxJudged);
    const truncated = grounded.length - queue.length;

    const judged: JudgedFlag[] = [];
    let requestsSpent = 1;
    let judgeFailures = 0;
    let shortPanels = 0;

    for (const candidate of queue) {
      const userPrompt = renderJudgeUserPrompt({
        cwe: candidate.flag.cwe,
        impact: candidate.flag.impact,
        repositoryName: candidate.file.repositoryName,
        path: candidate.file.path,
        lineStart: candidate.flag.lineStart,
        excerpt: candidate.excerpt,
      });

      // Judges run concurrently but never see each other's answers.
      const votes = await Promise.all(
        this.#judges.map(async (judge) => {
          try {
            const verdict = await judge.review(JUDGE_SYSTEM_PROMPT, userPrompt);
            return {
              family: judge.family,
              verdict: verdict.verdict,
              reason: verdict.reason,
            };
          } catch {
            return null;
          }
        }),
      );
      requestsSpent += this.#judges.length;

      const usable = votes.filter(
        (vote): vote is NonNullable<typeof vote> => vote !== null,
      );
      // Publication proceeds on whoever answered, on operator instruction:
      // availability was chosen over a hard two-family floor after a live day
      // where one provider's quota expiring would have silenced the whole
      // lane. A flag confirmed by a single judge still publishes, and the
      // lane is marked partial below so the ledger says the panel was short.
      // Deleting a SCANNER finding is a different path with a different rule
      // and still requires two seniors; this floor governs publication only.
      if (usable.length === 0) {
        judgeFailures += 1;
        continue;
      }
      if (usable.length < this.#judges.length) shortPanels += 1;
      judged.push({
        grounded: candidate,
        verdicts: usable,
        tier: tierFor(usable),
      });
    }

    const published = judged.filter((entry) => PUBLISHABLE.has(entry.tier));

    // State reflects how much of the lane actually executed, not how many
    // findings it produced. A scout that ran and found nothing is complete; a
    // batch we could not finish judging is partial. Only a scout that never
    // produced usable output is `ai_not_run`, because reporting an unfinished
    // review as a clean one is the failure mode this ledger exists to prevent.
    // A flag decided by fewer judges than the panel holds is honest cause
    // for "partly reviewed": the answer stands, the confidence behind it is
    // thinner than the configured council.
    const incomplete =
      judgeFailures > 0 || shortPanels > 0 || grounded.length > queue.length;

    return {
      state: incomplete ? "ai_partial" : "ai_complete",
      published,
      judged,
      groundingRejections: rejected,
      requestsSpent,
      unjudged: truncated,
      failure: null,
    };
  }
}
