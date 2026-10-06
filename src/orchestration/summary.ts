import { CONTRACT_LIMITS, type RunPhase } from "./types.ts";

/** Compact, read-only projection of the persisted bounded orchestration run. */
export interface ExecutionSummary {
  available: boolean;
  taskState?: RunPhase;
  route?: string;
  round?: number;
  maxRounds?: number;
  progress?: string;
  recoveryEvents?: string[];
  outcome?: "completed" | "failed" | "stopped" | "limit-reached";
  detail?: string;
}

const text = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** There is no storage TTL contract; this consumer-side cutoff avoids presenting old runs as current. */
export const EXECUTION_SUMMARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const RUN_PHASES = new Set<RunPhase>([
  "planning",
  "ready",
  "running",
  "evaluating",
  "repairing",
  "awaiting-human",
  "completed",
  "stopped",
  "failed",
]);

/** Extracts only known bounded fields; malformed, stale, or unusable persisted data is unavailable. */
export function summarizeExecutionRun(record: unknown, now = Date.now()): ExecutionSummary {
  try {
    if (!record || typeof record !== "object" || Array.isArray(record)) return { available: false };
    const envelope = record as Record<string, unknown>;
    if (!Number.isFinite(envelope.updatedAt) || !Number.isFinite(now) ||
      (envelope.updatedAt as number) > now || now - (envelope.updatedAt as number) > EXECUTION_SUMMARY_MAX_AGE_MS) {
      return { available: false };
    }
    const state = envelope.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) return { available: false };
    const run = state as Record<string, unknown>;
    if (typeof run.phase !== "string" || !RUN_PHASES.has(run.phase as RunPhase)) return { available: false };
    const phase = run.phase as RunPhase;
    const contract = run.contract && typeof run.contract === "object" && !Array.isArray(run.contract)
      ? run.contract as Record<string, unknown> : undefined;
    if (!contract) return { available: false };
    const maxRounds = Number.isInteger(contract.maxRounds) &&
      (contract.maxRounds as number) >= 1 && (contract.maxRounds as number) <= CONTRACT_LIMITS.maxRounds
      ? contract.maxRounds as number : undefined;
    const round = Number.isInteger(run.round) && (run.round as number) >= 0
      ? run.round as number : undefined;
    const history = Array.isArray(run.history) ? run.history : undefined;
    if (maxRounds === undefined || round === undefined || round > maxRounds ||
      history === undefined || history.length > Math.max(maxRounds + 2, 4)) return { available: false };
    if (run.lastError !== undefined && (typeof run.lastError !== "string" ||
      !run.lastError.trim() || run.lastError.length > 500)) return { available: false };
    const executor = run.executor === undefined ? {}
      : run.executor && typeof run.executor === "object" && !Array.isArray(run.executor)
        ? run.executor as Record<string, unknown> : undefined;
    if (!executor) return { available: false };
    const agent = text(executor.agent);
    const model = text(executor.model);
    if (run.executor !== undefined && (!agent || !model)) return { available: false };
    const lastError = text(run.lastError, 200);
    const pendingHuman = run.pendingHuman && typeof run.pendingHuman === "object"
      ? run.pendingHuman as Record<string, unknown> : undefined;
    let limitReached = false;
    if (phase === "awaiting-human") {
      if (!pendingHuman) return { available: false };
      const kind = pendingHuman.kind;
      const requestRound = pendingHuman.round;
      const minimumMaxRounds = pendingHuman.minimumMaxRounds;
      const requiredAuthority = round + 1 <= maxRounds ? "resume-or-stop" : "increase-budget-or-stop";
      if (typeof pendingHuman.requestID !== "string" || pendingHuman.requestID.length < 1 ||
        pendingHuman.requestID.length > 200 || (kind !== "jev-human" && kind !== "max-rounds") ||
        requestRound !== round || pendingHuman.currentMaxRounds !== maxRounds ||
        minimumMaxRounds !== round + 1 || pendingHuman.requiredAuthority !== requiredAuthority ||
        typeof pendingHuman.reason !== "string" || pendingHuman.reason.trim().length === 0 ||
        pendingHuman.reason.length > 500) return { available: false };
      limitReached = kind === "max-rounds" && round >= maxRounds &&
        requiredAuthority === "increase-budget-or-stop";
      if (kind === "max-rounds" && !limitReached) return { available: false };
    } else if (pendingHuman !== undefined) {
      return { available: false };
    }
    const outcome: ExecutionSummary["outcome"] = phase === "completed" ? "completed"
      : phase === "failed" ? "failed"
      : phase === "stopped" ? "stopped"
      : limitReached ? "limit-reached" : undefined;
    const detail = limitReached ? "Round limit reached; awaiting human review"
      : phase === "awaiting-human" ? "Awaiting human review"
      : phase === "stopped" ? "Execution safely stopped"
      : lastError || (pendingHuman ? text(pendingHuman.reason, 200) : undefined);
    const recoveryEvents = history.slice(-20).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const verdict = item.verdict && typeof item.verdict === "object" ? item.verdict as Record<string, unknown> : {};
      const action = text(verdict.nextAction, 40);
      const events: string[] = [];
      if (action && ["repair-same", "fresh-same", "switch-model", "switch-agent", "replan"].includes(action)) {
        events.push(`Round ${Number.isInteger(item.round) ? item.round : "?"}: ${action}`);
      }
      if (item.humanDecision && typeof item.humanDecision === "object") {
        const decision = item.humanDecision as Record<string, unknown>;
        if (decision.action === "resume") events.push("Execution resumed after human review");
        if (decision.action === "stop") events.push("Stopped by human decision");
      }
      return events;
    }).slice(-5).map((event) => event.slice(0, 120));
    return {
      available: true,
      taskState: phase,
      ...(outcome ? { outcome } : {}),
      ...(detail ? { detail } : {}),
      ...(agent || model ? { route: [agent, model].filter(Boolean).join(" / ").slice(0, 200) } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(round !== undefined && maxRounds !== undefined ? { progress: `Round ${Math.min(round, maxRounds)} of ${maxRounds}` } : {}),
      ...(recoveryEvents.length ? { recoveryEvents } : {}),
    };
  } catch {
    return { available: false };
  }
}
