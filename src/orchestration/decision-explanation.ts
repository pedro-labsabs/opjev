/** Structured, concise explanation for an orchestration routing/recovery decision.
 * This is metadata only: callers must not place prompts, credentials, or raw errors here.
 */
export type DecisionCategory = "routing" | "fallback" | "recovery";

const MAX_DECISION_TEXT = 240;
/** Maximum number of allowlisted evidence entries retained per explanation. */
export const DECISION_EXPLANATION_LIMITS = { evidenceItems: 8 } as const;
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

const DECISION_CATEGORIES: readonly DecisionCategory[] = ["routing", "fallback", "recovery"];
const DECISION_OUTCOMES: readonly DecisionOutcome[] = ["selected", "rejected", "recovered", "failed", "continued", "stopped", "awaiting-human"];
const DECISION_EVIDENCE_RESULTS: readonly DecisionEvidence["result"][] = ["met", "unmet", "eligible", "ineligible", "unknown"];

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`invalid decision explanation ${label}`);
  }
  return value as Record<string, unknown>;
}

function decisionCategory(value: unknown): DecisionCategory {
  if (typeof value === "string" && DECISION_CATEGORIES.includes(value as DecisionCategory)) return value as DecisionCategory;
  throw new TypeError("invalid decision explanation category");
}

function decisionOutcome(value: unknown): DecisionOutcome {
  if (typeof value === "string" && DECISION_OUTCOMES.includes(value as DecisionOutcome)) return value as DecisionOutcome;
  throw new TypeError("invalid decision explanation outcome");
}

function evidenceResult(value: unknown): DecisionEvidence["result"] {
  if (typeof value === "string" && DECISION_EVIDENCE_RESULTS.includes(value as DecisionEvidence["result"])) return value as DecisionEvidence["result"];
  throw new TypeError("invalid decision explanation evidence result");
}

function sanitizeRoute(value: unknown, label: string): DecisionRoute {
  const input = inputRecord(value, label);
  const route: DecisionRoute = {};
  if (typeof input.lane === "string" && input.lane) route.lane = sanitizeDecisionText(input.lane);
  if (typeof input.agent === "string" && input.agent) route.agent = sanitizeDecisionText(input.agent);
  if (typeof input.model === "string" && input.model) route.model = sanitizeDecisionText(input.model);
  return route;
}

function sanitizeFallback(value: unknown, label: string): DecisionFallbackContext {
  const input = inputRecord(value, label);
  const fallback: DecisionFallbackContext = { reason: sanitizeDecisionText(input.reason) };
  if (input.rejected !== undefined) fallback.rejected = sanitizeRoute(input.rejected, `${label}.rejected`);
  if (input.selected !== undefined) fallback.selected = sanitizeRoute(input.selected, `${label}.selected`);
  return fallback;
}

function sanitizeRecovery(value: unknown): DecisionRecoveryContext {
  const input = inputRecord(value, "recovery");
  const recovery: DecisionRecoveryContext = {
    action: sanitizeDecisionText(input.action),
    outcome: sanitizeDecisionText(input.outcome),
  };
  if (input.route !== undefined) recovery.route = sanitizeRoute(input.route, "recovery.route");
  if (input.fallback !== undefined) recovery.fallback = sanitizeFallback(input.fallback, "recovery.fallback");
  return recovery;
}

/** Project only the canonical, sanitized, bounded decision explanation schema. */
export function sanitizeDecisionExplanation(explanation: DecisionExplanation): DecisionExplanation {
  const input = inputRecord(explanation, "object");
  const sanitized: DecisionExplanation = {
    category: decisionCategory(input.category),
    outcome: decisionOutcome(input.outcome),
    reason: sanitizeDecisionText(input.reason),
  };

  if (input.selected !== undefined) sanitized.selected = sanitizeRoute(input.selected, "selected");
  if (input.evidence !== undefined) {
    if (!Array.isArray(input.evidence)) throw new TypeError("invalid decision explanation evidence");
    sanitized.evidence = input.evidence
      .slice(0, DECISION_EXPLANATION_LIMITS.evidenceItems)
      .map((item, index) => {
        const evidence = inputRecord(item, `evidence[${index}]`);
        const projected: DecisionEvidence = {
          name: sanitizeDecisionText(evidence.name),
          result: evidenceResult(evidence.result),
        };
        if (evidence.detail !== undefined) projected.detail = sanitizeDecisionText(evidence.detail);
        return projected;
      });
  }
  if (input.fallback !== undefined) sanitized.fallback = sanitizeFallback(input.fallback, "fallback");
  if (input.recovery !== undefined) sanitized.recovery = sanitizeRecovery(input.recovery);
  return sanitized;
}
