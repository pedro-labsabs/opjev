import type { UsageWindow } from "./usage-ledger.ts";

export type PressureLevel = "unknown" | "low" | "moderate" | "high" | "critical";
export type PressureConfidence = "none" | "low" | "medium" | "high";
export interface PressureSignal {
  level: PressureLevel;
  confidence: PressureConfidence;
  provenance: string[];
  observedCount?: number;
}
export type ResourceProfile = "normal" | "conservative" | "scarce" | "survival";
export interface ResourcePressure {
  estimatedAt: number;
  window: { from: number; to: number };
  quota: PressureSignal;
  rate: PressureSignal;
  context: PressureSignal;
  execution: PressureSignal;
  availability: PressureSignal;
  profile: ResourceProfile;
  profileBasis: "deterministic-maximum-dimension";
  /** Explicitly advisory. Consumers must not treat this as permission or routing. */
  mode: "observation";
}

const unknown = (): PressureSignal => ({ level: "unknown", confidence: "none", provenance: [] });
const signal = (level: PressureLevel, confidence: PressureConfidence, provenance: string[], observedCount?: number): PressureSignal => ({ level, confidence, provenance, ...(observedCount === undefined ? {} : { observedCount }) });

/** Deterministic estimate from bounded observations. It never emits quota remaining or executor choices. */
export function estimateResourcePressure(usage: UsageWindow, estimatedAt = usage.to): ResourcePressure {
  const quota = usage.quotaLimits > 0
    ? signal("critical", "high", ["observed-quota-limit"], usage.quotaLimits)
    : unknown();
  const rate = usage.throttles > 0
    ? signal(usage.throttles >= 3 ? "high" : "moderate", usage.throttles >= 3 ? "high" : "medium", ["observed-throttle"], usage.throttles)
    : unknown();
  const context = usage.contextOverflows > 0
    ? signal(usage.contextOverflows >= 2 ? "critical" : "high", "high", ["observed-context-overflow"], usage.contextOverflows)
    : unknown();
  const executionCount = usage.retries + usage.operationalFailures;
  const execution = executionCount > 0
    ? signal(executionCount >= 5 ? "high" : "moderate", executionCount >= 5 ? "medium" : "low", [usage.retries ? "observed-retries" : "observed-operational-failure"], executionCount)
    : unknown();
  const availability = usage.providerFailures > 0
    ? signal(usage.providerFailures >= 3 ? "high" : "moderate", usage.providerFailures >= 3 ? "high" : "medium", ["provider-failure"], usage.providerFailures)
    : unknown();
  const levels = [quota, rate, context, execution, availability].map(x => x.level);
  const max = (rank: Record<PressureLevel, number>) => Math.max(...levels.map(x => rank[x]));
  const rank: Record<PressureLevel, number> = { unknown: 0, low: 1, moderate: 2, high: 3, critical: 4 };
  const peak = max(rank);
  const profile: ResourceProfile = peak >= 4 ? "survival" : peak >= 3 ? "scarce" : peak >= 2 ? "conservative" : "normal";
  return {
    estimatedAt, window: { from: usage.from, to: usage.to }, quota, rate, context, execution, availability,
    profile, profileBasis: "deterministic-maximum-dimension", mode: "observation",
  };
}
