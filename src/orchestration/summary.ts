/** Compact, read-only projection of the persisted bounded orchestration run. */
export interface ExecutionSummary {
  available: boolean;
  taskState?: string;
  route?: string;
  round?: number;
  maxRounds?: number;
  progress?: string;
  recoveryEvents?: string[];
  outcome?: "completed" | "failed" | "limit-reached";
  detail?: string;
}

const text = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** There is no storage TTL contract; this consumer-side cutoff avoids presenting old runs as current. */
export const EXECUTION_SUMMARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
    const phaseValue = (state as Record<string, unknown>).phase;
    if (typeof phaseValue !== "string" || !phaseValue.trim()) return { available: false };
    const run = state as Record<string, unknown>;
    const contract = run.contract && typeof run.contract === "object"
      ? run.contract as Record<string, unknown> : {};
    const executor = run.executor && typeof run.executor === "object"
      ? run.executor as Record<string, unknown> : {};
    const agent = text(executor.agent);
    const model = text(executor.model);
    const round = Number.isInteger(run.round) && (run.round as number) >= 0 ? run.round as number : undefined;
    const maxRounds = Number.isInteger(contract.maxRounds) && (contract.maxRounds as number) > 0
      ? contract.maxRounds as number : undefined;
    const phase = text(run.phase, 40);
    const lastError = text(run.lastError, 200);
    const pendingHuman = run.pendingHuman && typeof run.pendingHuman === "object"
      ? run.pendingHuman as Record<string, unknown> : undefined;
    const limitReached = phase === "limit-reached" ||
      (phase === "awaiting-human" && round !== undefined && maxRounds !== undefined && round >= maxRounds);
    const outcome: ExecutionSummary["outcome"] = phase === "completed" ? "completed"
      : phase === "failed" || phase === "stopped" ? "failed"
      : limitReached ? "limit-reached" : undefined;
    const detail = limitReached ? (phase === "limit-reached" ? "Round limit reached" : "Round limit reached; awaiting human review")
      : phase === "awaiting-human" ? "Awaiting human review"
      : phase === "stopped" ? "Execution safely stopped"
      : lastError || (pendingHuman ? text(pendingHuman.reason, 200) : undefined);
    const history = Array.isArray(run.history) ? run.history.slice(-20) : [];
    const recoveryEvents = history.flatMap((entry: unknown) => {
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
      ...(phase ? { taskState: phase } : {}),
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
