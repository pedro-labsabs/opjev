/** Shared, factual telemetry for resource governance and future model intelligence. */
export type ObservationKind =
  | "unknown"
  | "request" | "round" | "retry" | "recovery" | "escalation" | "outcome" | "fanout"
  | "compaction" | "token-usage" | "throttle" | "quota-limit" | "context-overflow"
  | "provider-error" | "operational-failure";

export interface UsageObservation {
  at?: number;
  kind: ObservationKind;
  runID?: string;
  sessionID?: string;
  model?: string;
  agent?: string;
  route?: "fast-coding" | "heavy-reasoning" | "research-docs";
  role?: "worker" | "critic" | "orchestrator" | "jev" | "provider" | "unknown";
  acceptance?: boolean;
  verificationPassed?: boolean;
  failureClass?: "none" | "implementation" | "reasoning" | "missing-context" | "wrong-agent" | "wrong-model" | "environment" | "bad-contract";
  recoveryAction?: "repair-same" | "fresh-same" | "switch-model" | "switch-agent" | "replan" | "human-resume";
  round?: number;
  retry?: number;
  statusCode?: number;
  signal?: "rate-limit" | "throttle" | "overload" | "unknown";
  errorCode?: string;
  failureDomain?: "provider" | "quota" | "context" | "execution" | "operational" | "unknown";
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
}

const KINDS = new Set<ObservationKind>([
  "unknown",
  "request", "round", "retry", "recovery", "escalation", "outcome", "fanout", "compaction",
  "token-usage", "throttle", "quota-limit", "context-overflow", "provider-error", "operational-failure",
]);
const STRINGS = ["runID", "sessionID", "model", "agent", "errorCode"] as const;
const MAX_TEXT = 160;
const MAX_IDENTITY = 200; // Matches the bounded run/session identity contracts.
const SAFE_ERROR_CODES = new Set(["FreeUsageLimitError", "quota-limit", "provider-error", "context-overflow", "operational-failure", "429", "529"]);
const TOKEN_KEYS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;
const ROUTES = new Set(["fast-coding", "heavy-reasoning", "research-docs"]);
const FAILURE_CLASSES = new Set(["none", "implementation", "reasoning", "missing-context", "wrong-agent", "wrong-model", "environment", "bad-contract"]);
const RECOVERY_ACTIONS = new Set(["repair-same", "fresh-same", "switch-model", "switch-agent", "replan", "human-resume"]);

/** Strict whitelist: prompts, messages, stack traces, and arbitrary payloads are discarded. */
export function sanitizeObservation(value: unknown): UsageObservation {
  const x = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const kind = KINDS.has(x.kind as ObservationKind) ? x.kind as ObservationKind : "unknown";
  const out: UsageObservation = {
    kind,
  };
  if (typeof x.at === "number" && Number.isFinite(x.at)) out.at = x.at;
  for (const key of STRINGS) if (typeof x[key] === "string" && (x[key] as string).length) {
    if (key === "errorCode" && !SAFE_ERROR_CODES.has(x[key] as string)) continue;
    const limit = key === "runID" || key === "sessionID" ? MAX_IDENTITY : MAX_TEXT;
    (out as any)[key] = (x[key] as string).slice(0, limit);
  }
  if (ROUTES.has(String(x.route))) out.route = x.route as UsageObservation["route"];
  if (["worker", "critic", "orchestrator", "jev", "provider", "unknown"].includes(String(x.role))) out.role = x.role as UsageObservation["role"];
  if (typeof x.acceptance === "boolean") out.acceptance = x.acceptance;
  if (typeof x.verificationPassed === "boolean") out.verificationPassed = x.verificationPassed;
  if (FAILURE_CLASSES.has(String(x.failureClass))) out.failureClass = x.failureClass as UsageObservation["failureClass"];
  if (RECOVERY_ACTIONS.has(String(x.recoveryAction))) out.recoveryAction = x.recoveryAction as UsageObservation["recoveryAction"];
  if (["provider", "quota", "context", "execution", "operational", "unknown"].includes(String(x.failureDomain))) out.failureDomain = x.failureDomain as UsageObservation["failureDomain"];
  if (["rate-limit", "throttle", "overload", "unknown"].includes(String(x.signal))) out.signal = x.signal as UsageObservation["signal"];
  for (const key of ["round", "retry", "statusCode"] as const) if (Number.isInteger(x[key]) && Number(x[key]) >= 0) out[key] = Number(x[key]);
  const tokens = x.tokens && typeof x.tokens === "object" ? x.tokens as Record<string, unknown> : {};
  const observed: NonNullable<UsageObservation["tokens"]> = {};
  for (const key of TOKEN_KEYS) if (Number.isFinite(tokens[key]) && Number(tokens[key]) >= 0) observed[key] = Number(tokens[key]);
  if (Object.keys(observed).length) out.tokens = observed;
  return out;
}

/** Fixed-capacity ring. Oldest facts are overwritten; raw history cannot grow indefinitely. */
export class UsageLedger {
  private readonly entries: Array<UsageObservation | undefined>;
  private cursor = 0;
  private count = 0;
  readonly capacity: number;
  constructor(options: { capacity?: number } = {}) {
    const requested = options.capacity ?? 2048;
    this.capacity = Number.isInteger(requested) ? Math.max(1, Math.min(10000, requested)) : 2048;
    this.entries = new Array(this.capacity);
  }
  get size(): number { return this.count; }
  append(value: unknown): UsageObservation {
    const safe = sanitizeObservation(value);
    this.entries[this.cursor] = safe;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    return safe;
  }
  snapshot(): UsageObservation[] {
    const start = (this.cursor - this.count + this.capacity) % this.capacity;
    return Array.from({ length: this.count }, (_, i) => this.entries[(start + i) % this.capacity]!).map(x => ({ ...x, ...(x.tokens ? { tokens: { ...x.tokens } } : {}) }));
  }
  replace(values: unknown[]): void {
    this.cursor = 0; this.count = 0;
    for (const value of values.slice(-this.capacity)) this.append(value);
  }
}

export interface UsageWindow {
  from: number;
  to: number;
  requests: number;
  rounds: number;
  retries: number;
  recoveries: number;
  escalations: number;
  fanouts: number;
  compactions: number;
  throttles: number;
  quotaLimits: number;
  contextOverflows: number;
  providerFailures: number;
  operationalFailures: number;
  tokens: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
  observations: number;
}

export function aggregateUsage(values: readonly unknown[], window: { from: number; to: number }): UsageWindow {
  const out: UsageWindow = {
    from: window.from, to: window.to, requests: 0, rounds: 0, retries: 0, recoveries: 0, escalations: 0,
    fanouts: 0, compactions: 0, throttles: 0, quotaLimits: 0, contextOverflows: 0,
    providerFailures: 0, operationalFailures: 0, tokens: {}, observations: 0,
  };
  for (const raw of values) {
    const x = sanitizeObservation(raw);
    if (x.at === undefined) continue; // timestamp unknown: never fabricate window membership
    if (x.at < window.from || x.at > window.to) continue;
    out.observations++;
    const key: Partial<Record<ObservationKind, keyof UsageWindow>> = {
    request: "requests", round: "rounds", retry: "retries", recovery: "recoveries", escalation: "escalations",
      fanout: "fanouts", compaction: "compactions", throttle: "throttles", "quota-limit": "quotaLimits",
      "context-overflow": "contextOverflows", "provider-error": "providerFailures", "operational-failure": "operationalFailures",
    };
    const count = key[x.kind];
    if (count) (out[count] as number)++;
    for (const token of TOKEN_KEYS) if (x.tokens?.[token] !== undefined) out.tokens[token] = (out.tokens[token] ?? 0) + x.tokens[token]!;
  }
  return out;
}
