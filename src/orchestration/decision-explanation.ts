/** Structured, concise explanation for an orchestration routing/recovery decision.
 * This is metadata only: callers must not place prompts, credentials, or raw errors here.
 */
export type DecisionCategory = "routing" | "fallback" | "recovery";

const MAX_DECISION_TEXT = 240;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\b\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const COMMON_CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g;

/** Redact credentials and bound arbitrary text before it enters decision metadata. */
export function sanitizeDecisionText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(BEARER_CREDENTIAL, "Bearer [REDACTED]")
    .replace(COMMON_CREDENTIAL, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_DECISION_TEXT);
}

/** Construct a defensive copy containing only sanitized, bounded metadata. */
export function sanitizeDecisionExplanation<T extends DecisionExplanation>(explanation: T): T {
  const route = (value?: DecisionRoute): DecisionRoute | undefined => value && ({
    ...(value.lane ? { lane: sanitizeDecisionText(value.lane) } : {}),
    ...(value.agent ? { agent: sanitizeDecisionText(value.agent) } : {}),
    ...(value.model ? { model: sanitizeDecisionText(value.model) } : {}),
  });
  const fallback = (value?: DecisionFallbackContext): DecisionFallbackContext | undefined => value && ({
    ...(value.rejected ? { rejected: route(value.rejected) } : {}),
    reason: sanitizeDecisionText(value.reason),
    ...(value.selected ? { selected: route(value.selected) } : {}),
  });
  return {
    ...explanation,
    reason: sanitizeDecisionText(explanation.reason),
    ...(explanation.selected ? { selected: route(explanation.selected) } : {}),
    ...(explanation.evidence ? { evidence: explanation.evidence.map(item => ({ ...item, name: sanitizeDecisionText(item.name), ...(item.detail ? { detail: sanitizeDecisionText(item.detail) } : {}) })) } : {}),
    ...(explanation.fallback ? { fallback: fallback(explanation.fallback) } : {}),
    ...(explanation.recovery ? { recovery: { ...explanation.recovery, action: sanitizeDecisionText(explanation.recovery.action), outcome: sanitizeDecisionText(explanation.recovery.outcome), ...(explanation.recovery.route ? { route: route(explanation.recovery.route) } : {}), ...(explanation.recovery.fallback ? { fallback: fallback(explanation.recovery.fallback) } : {}) } } : {}),
  };
}
export type DecisionOutcome = "selected" | "rejected" | "recovered" | "failed" | "continued" | "stopped" | "awaiting-human";

/** Identifiers for the route considered or selected (task lane and executor). */
export interface DecisionRoute {
  lane?: string;
  agent?: string;
  model?: string;
}

/** Safe, concise metadata describing constraints or eligibility evidence. */
export interface DecisionEvidence {
  /** Stable constraint/evidence name, not arbitrary user-provided content. */
  name: string;
  /** Whether the constraint/evidence allowed or prevented selection. */
  result: "met" | "unmet" | "eligible" | "ineligible" | "unknown";
  /** Optional short, sanitized detail. */
  detail?: string;
}

export interface DecisionFallbackContext {
  /** Candidate that could not be used. */
  rejected?: DecisionRoute;
  /** Safe category explaining why it could not be used. */
  reason: string;
  /** Route selected instead, when one exists. */
  selected?: DecisionRoute;
}

export interface DecisionRecoveryContext {
  /** Recovery action, e.g. retry, switch-model, switch-agent, or replan. */
  action: string;
  /** Concise outcome rationale. */
  outcome: string;
  /** Optional associated route/fallback details. */
  route?: DecisionRoute;
  fallback?: DecisionFallbackContext;
}

/** Common explanation envelope used by normal selection, fallback, and recovery. */
export interface DecisionExplanation {
  category: DecisionCategory;
  outcome: DecisionOutcome;
  /** Route selected by this decision; absent when no route was selected. */
  selected?: DecisionRoute;
  /** Brief human-readable explanation. */
  reason: string;
  /** Relevant bounds/eligibility facts supporting the decision. */
  evidence?: DecisionEvidence[];
  /** Present for fallback decisions or when recovery followed a fallback. */
  fallback?: DecisionFallbackContext;
  /** Present for recovery decisions. */
  recovery?: DecisionRecoveryContext;
}
