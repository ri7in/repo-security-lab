import { COUNCIL, isVerified, type ModelAllowance, type ModelRole } from "./models.js";

/**
 * Deep-read budgeting across the council.
 *
 * The council only works when every member can still run, so the reported
 * budget is the SCARCEST member's remaining share, never an average and never
 * the most generous member. When the scarcest member is exhausted the lane is
 * unavailable for the rest of the UTC day even if the others have headroom.
 */

/** Repositories given a full model read per request. */
export const DEEP_READ_REPO_LIMIT = 3;

/**
 * Modeled tokens for one repository, per role.
 *
 * Measured on the operator's own account 2026-08-21 after stripping images,
 * lockfiles and vendored directories: 40k tokens (myslt-alerts), 48k (salun),
 * 67k (ctse-assignment), 80k (Airplane-OSGI), 86k (ubereats-restarueny).
 * The reader figure is the measured ceiling plus output headroom. Judges never
 * receive a repository: they re-check one finding with its surrounding lines.
 */
export const MODELED_TOKENS_PER_REPO: Readonly<Record<ModelRole, number>> = {
  reader: 90_000,
  judge: 12_000,
};

/**
 * Modeled provider requests for one whole-account scan.
 *
 * The reader takes the entire account in a single request, which is why the
 * scout's ceiling is 50 scans/day rather than 50 repositories. Judges are
 * charged per flag reviewed, so `maxJudgedFlags` in the funnel is what really
 * decides how many scans a day affords.
 */
export const MODELED_REQUESTS_PER_SCAN: Readonly<Record<ModelRole, number>> = {
  reader: 1,
  judge: 20,
};

/** Modeled provider requests for one repository, per role. */
export const MODELED_REQUESTS_PER_REPO: Readonly<Record<ModelRole, number>> = {
  reader: 1,
  judge: 4,
};

export interface ModelSpend {
  readonly tokens: number;
  readonly requests: number;
}

export const ZERO_SPEND: ModelSpend = { tokens: 0, requests: 0 };

export interface ModelCapacity {
  readonly modelId: string;
  /** Whole repositories this model can still serve today. */
  readonly deepReadsRemaining: number;
  /** Whole repositories this model serves on an untouched day. */
  readonly deepReadsPerDay: number;
  /** Remaining share of this model's own day, 0 to 100. */
  readonly percentRemaining: number;
}

export interface CouncilBudget {
  /** Remaining share of the scarcest member's day, 0 to 100. */
  readonly percentRemaining: number;
  /** The member that limits the council right now. */
  readonly scarcestModelId: string;
  /** Repositories the whole council can still deep-read today. */
  readonly deepReadsRemaining: number;
  /** Repositories the council deep-reads on an untouched day. */
  readonly deepReadsPerDay: number;
  /** Repositories deep-read for a single request. */
  readonly repoLimitPerRequest: number;
  /** False once any member is exhausted. */
  readonly available: boolean;
  /** False while any member's limits are unconfirmed against a primary source. */
  readonly limitsVerified: boolean;
  /** Distinct routing surfaces in the council, for public disclosure. */
  readonly providers: readonly string[];
  readonly perModel: readonly ModelCapacity[];
}

function floorDiv(available: number, cost: number): number {
  if (cost <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(available / cost));
}

/** Repositories a single model can still serve, bounded by every published limit. */
export function modelCapacity(
  model: ModelAllowance,
  spend: ModelSpend = ZERO_SPEND,
): ModelCapacity {
  const tokenCost = MODELED_TOKENS_PER_REPO[model.role];
  const requestCost = MODELED_REQUESTS_PER_REPO[model.role];

  const bound = (spentTokens: number, spentRequests: number): number => {
    const byRequests = floorDiv(
      model.requestsPerDay - spentRequests,
      requestCost,
    );
    if (model.tokensPerDay === null) return byRequests;
    return Math.min(
      byRequests,
      floorDiv(model.tokensPerDay - spentTokens, tokenCost),
    );
  };

  const deepReadsPerDay = bound(0, 0);
  const deepReadsRemaining = Math.min(
    deepReadsPerDay,
    bound(Math.max(0, spend.tokens), Math.max(0, spend.requests)),
  );
  const percentRemaining =
    deepReadsPerDay <= 0
      ? 0
      : Math.round((deepReadsRemaining / deepReadsPerDay) * 100);

  return {
    modelId: model.id,
    deepReadsRemaining,
    deepReadsPerDay,
    percentRemaining,
  };
}

/**
 * The council budget. `spend` maps model id to today's usage; a model missing
 * from the map is treated as unused rather than as an error, so a partially
 * recorded day degrades toward optimism only for models we truly did not call.
 */
export function councilBudget(
  spend: ReadonlyMap<string, ModelSpend> = new Map(),
  council: readonly ModelAllowance[] = COUNCIL,
): CouncilBudget {
  if (council.length === 0) {
    return {
      percentRemaining: 0,
      scarcestModelId: "none",
      deepReadsRemaining: 0,
      deepReadsPerDay: 0,
      repoLimitPerRequest: DEEP_READ_REPO_LIMIT,
      available: false,
      limitsVerified: false,
      providers: [],
      perModel: [],
    };
  }

  const perModel = council.map((model) =>
    modelCapacity(model, spend.get(model.id) ?? ZERO_SPEND),
  );

  let scarcest = perModel[0] as ModelCapacity;
  for (const candidate of perModel) {
    if (
      candidate.percentRemaining < scarcest.percentRemaining ||
      (candidate.percentRemaining === scarcest.percentRemaining &&
        candidate.deepReadsRemaining < scarcest.deepReadsRemaining)
    ) {
      scarcest = candidate;
    }
  }

  const deepReadsRemaining = Math.min(
    ...perModel.map((entry) => entry.deepReadsRemaining),
  );
  const deepReadsPerDay = Math.min(
    ...perModel.map((entry) => entry.deepReadsPerDay),
  );

  return {
    percentRemaining: scarcest.percentRemaining,
    scarcestModelId: scarcest.modelId,
    deepReadsRemaining,
    deepReadsPerDay,
    repoLimitPerRequest: DEEP_READ_REPO_LIMIT,
    available: deepReadsRemaining > 0,
    limitsVerified: council.every(isVerified),
    providers: [...new Set(council.map((model) => model.provider))],
    perModel,
  };
}

/**
 * Narrows a council budget to the public DTO shape.
 *
 * `perModel` is dropped deliberately: per-member capacity is operator
 * diagnostics, and publishing it would let a visitor infer which provider
 * accounts back the service and how heavily each is used.
 */
export function toDeepReadBudget(budget: CouncilBudget): {
  readonly available: boolean;
  readonly percentRemaining: number;
  readonly scarcestModelId: string;
  readonly deepReadsRemaining: number;
  readonly deepReadsPerDay: number;
  readonly repoLimitPerRequest: number;
  readonly limitsVerified: boolean;
  readonly providers: string[];
} {
  return {
    available: budget.available,
    percentRemaining: budget.percentRemaining,
    scarcestModelId: budget.scarcestModelId,
    deepReadsRemaining: budget.deepReadsRemaining,
    deepReadsPerDay: budget.deepReadsPerDay,
    repoLimitPerRequest: budget.repoLimitPerRequest,
    limitsVerified: budget.limitsVerified,
    providers: [...budget.providers],
  };
}
