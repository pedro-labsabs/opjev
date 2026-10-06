import { sanitizeObservation, type UsageObservation } from "../resource-governor/usage-ledger.ts";

export const MODEL_PROFILE_MIN_SAMPLES = 5;
export const MODEL_PROFILE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface ModelObserveProfile {
  route?: UsageObservation["route"];
  role?: UsageObservation["role"];
  agent?: string;
  model: string;
  sampleCount: number;
  capability: {
    samples: number;
    accepted: number;
    rejected: number;
    acceptanceRate?: number;
    uncertainty: "high" | "provisional";
  };
  efficiency: {
    acceptedOutcomes: number;
    requestsPerAccepted?: number;
    roundsPerAccepted?: number;
    inputTokensPerAccepted?: number;
    outputTokensPerAccepted?: number;
    reasoningTokensPerAccepted?: number;
    cacheReadTokensPerAccepted?: number;
    cacheWriteTokensPerAccepted?: number;
    uncertainty: "high" | "provisional";
  };
  availability: {
    samples: number;
    providerFailures: number;
    throttles: number;
    quotaLimits: number;
    uncertainty: "high" | "provisional";
  };
  recovery: {
    samples: number;
    attempts: number;
    acceptedAfterRecovery: number;
    actions: Partial<Record<NonNullable<UsageObservation["recoveryAction"]>, number>>;
    uncertainty: "high" | "provisional";
  };
  freshness: { newestAt: number; stale: boolean };
}

export interface ModelProfileOptions {
  from: number;
  to: number;
  now?: number;
  minCapabilitySamples?: number;
  staleAfterMs?: number;
}

interface Bucket {
  route?: UsageObservation["route"];
  role?: UsageObservation["role"];
  agent?: string;
  model: string;
  observations: UsageObservation[];
}

/**
 * Build deterministic contextual profiles from sanitized facts in the shared,
 * bounded resource ledger. This function has no storage, clock, or routing I/O.
 */
export function buildObserveProfiles(values: readonly unknown[], options: ModelProfileOptions): ModelObserveProfile[] {
  const now = Number.isFinite(options.now) ? options.now! : options.to;
  const minSamples = positiveInteger(options.minCapabilitySamples, MODEL_PROFILE_MIN_SAMPLES);
  const staleAfterMs = positiveInteger(options.staleAfterMs, MODEL_PROFILE_STALE_AFTER_MS);
  const buckets = new Map<string, Bucket>();

  for (const raw of values) {
    const observation = sanitizeObservation(raw);
    if (observation.at === undefined || observation.at < options.from || observation.at > options.to || !observation.model) continue;
    const key = JSON.stringify([observation.route ?? null, observation.role ?? null, observation.agent ?? null, observation.model]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { route: observation.route, role: observation.role, agent: observation.agent, model: observation.model, observations: [] };
      buckets.set(key, bucket);
    }
    bucket.observations.push(observation);
  }

  return [...buckets.values()].map(bucket => buildProfile(bucket, now, staleAfterMs, minSamples)).sort((a, b) =>
    (a.route ?? "").localeCompare(b.route ?? "") ||
    (a.role ?? "").localeCompare(b.role ?? "") ||
    (a.agent ?? "").localeCompare(b.agent ?? "") ||
    a.model.localeCompare(b.model),
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function buildProfile(bucket: Bucket, now: number, staleAfterMs: number, minSamples: number): ModelObserveProfile {
  const facts = bucket.observations;
  const workerFacts = facts.filter(x => x.role === "worker");
  const capabilityFacts = workerFacts.filter(x =>
    x.kind === "outcome" && typeof x.acceptance === "boolean" && x.verificationPassed === true &&
    x.failureClass !== undefined && x.failureClass !== "environment" && x.failureClass !== "bad-contract",
  );
  const accepted = capabilityFacts.filter(x => x.acceptance === true).length;
  const rejected = capabilityFacts.length - accepted;
  const availabilityFacts = facts.filter(x => ["provider-error", "throttle", "quota-limit"].includes(x.kind));
  const providerFailures = availabilityFacts.filter(x => x.kind === "provider-error").length;
  const throttles = availabilityFacts.filter(x => x.kind === "throttle").length;
  const quotaLimits = availabilityFacts.filter(x => x.kind === "quota-limit").length;
  const recoveryFacts = workerFacts.filter(x =>
    (x.kind === "recovery" || x.kind === "escalation") && x.recoveryAction !== undefined,
  );
  const actions: ModelObserveProfile["recovery"]["actions"] = {};
  for (const fact of recoveryFacts) if (fact.recoveryAction) actions[fact.recoveryAction] = (actions[fact.recoveryAction] ?? 0) + 1;
  const acceptedAfterRecovery = capabilityFacts.filter(x => x.acceptance && x.recoveryAction).length;
  const acceptedOutcomes = capabilityFacts.filter(x => x.acceptance).length;
  const workerTokens = workerFacts.filter(x => x.kind === "token-usage");
  const inputTokens = sum(workerTokens.map(x => x.tokens?.input));
  const outputTokens = sum(workerTokens.map(x => x.tokens?.output));
  const reasoningTokens = sum(workerTokens.map(x => x.tokens?.reasoning));
  const cacheReadTokens = sum(workerTokens.map(x => x.tokens?.cacheRead));
  const cacheWriteTokens = sum(workerTokens.map(x => x.tokens?.cacheWrite));
  const requests = workerFacts.filter(x => x.kind === "request").length;
  const rounds = workerFacts.filter(x => x.kind === "round").length;
  const newestAt = Math.max(...facts.map(x => x.at!));
  const uncertain = (samples: number) => samples < minSamples ? "high" as const : "provisional" as const;

  return {
    ...(bucket.route ? { route: bucket.route } : {}),
    ...(bucket.role ? { role: bucket.role } : {}),
    ...(bucket.agent ? { agent: bucket.agent } : {}),
    model: bucket.model,
    sampleCount: facts.length,
    capability: {
      samples: capabilityFacts.length,
      accepted,
      rejected,
      ...(capabilityFacts.length ? { acceptanceRate: accepted / capabilityFacts.length } : {}),
      uncertainty: uncertain(capabilityFacts.length),
    },
    efficiency: {
      acceptedOutcomes,
      ...(acceptedOutcomes ? {
        requestsPerAccepted: requests / acceptedOutcomes,
        roundsPerAccepted: rounds / acceptedOutcomes,
        ...(inputTokens !== undefined ? { inputTokensPerAccepted: inputTokens / acceptedOutcomes } : {}),
        ...(outputTokens !== undefined ? { outputTokensPerAccepted: outputTokens / acceptedOutcomes } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokensPerAccepted: reasoningTokens / acceptedOutcomes } : {}),
        ...(cacheReadTokens !== undefined ? { cacheReadTokensPerAccepted: cacheReadTokens / acceptedOutcomes } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokensPerAccepted: cacheWriteTokens / acceptedOutcomes } : {}),
      } : {}),
      uncertainty: uncertain(acceptedOutcomes),
    },
    availability: {
      samples: availabilityFacts.length,
      providerFailures,
      throttles,
      quotaLimits,
      uncertainty: uncertain(availabilityFacts.length),
    },
    recovery: {
      samples: recoveryFacts.length,
      attempts: recoveryFacts.length,
      acceptedAfterRecovery,
      actions,
      uncertainty: uncertain(recoveryFacts.length),
    },
    freshness: { newestAt, stale: now - newestAt > staleAfterMs },
  };
}

function sum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((x): x is number => x !== undefined);
  return present.length ? present.reduce((total, value) => total + value, 0) : undefined;
}
