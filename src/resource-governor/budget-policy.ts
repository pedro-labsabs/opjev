import type { ResourcePressure, PressureLevel } from "./pressure-estimator.ts";

export type BudgetStage = "jev-decision" | "new-round" | "provider-retry" | "switch" | "replan";
export interface ResourceBudgetDecision {
  allowed: boolean;
  stage: BudgetStage;
  effectiveMaxRounds: number;
  reason: string;
  basis: string[];
}

/** Pure local policy over a fixed 15 minute observation window. It never routes. */
export const RESOURCE_POLICY_WINDOW_MS = 15 * 60 * 1000;
const rank: Record<PressureLevel, number> = { unknown: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export function decideResourceBudget(input: {
  pressure: ResourcePressure;
  maxRounds: number;
  round: number;
  stage: BudgetStage;
}): ResourceBudgetDecision {
  const { pressure, stage } = input;
  const hardQuota = pressure.quota.level === "critical";
  const hardThrottle = rank[pressure.rate.level] >= rank.high;
  const retryStorm = rank[pressure.execution.level] >= rank.high;
  const adaptivePressure = rank[pressure.rate.level] >= rank.moderate || rank[pressure.execution.level] >= rank.moderate || rank[pressure.availability.level] >= rank.moderate;
  const effectiveMaxRounds = Math.min(input.maxRounds, adaptivePressure ? 2 : input.maxRounds);
  const adaptiveCapActive = effectiveMaxRounds < input.maxRounds;
  const spendStage = stage === "provider-retry" || stage === "jev-decision" || stage === "new-round" || stage === "switch" || stage === "replan";
  const hardPressure = hardThrottle || retryStorm;
  const capReached = adaptiveCapActive && ((stage === "new-round" && input.round > effectiveMaxRounds) || ((stage === "switch" || stage === "replan") && input.round >= effectiveMaxRounds));
  const blocked = hardQuota || (spendStage && hardPressure) || capReached;
  const basis = [hardQuota && "quota-critical", hardThrottle && "rate-high", retryStorm && "execution-high", adaptivePressure && "adaptive-round-cap"].filter(Boolean) as string[];
  return {
    allowed: !blocked,
    stage,
    effectiveMaxRounds,
    reason: blocked ? `resource-budget:${basis.join(",")}` : "resource-budget:within-observed-bounds",
    basis,
  };
}
