// Replan prompt/parser do orchestrator (#11).
//
// Puro e testavel: nao importa ctx. O orchestrator (sessao read-only avec
// logical role orchestrator) propoe UM ExecutionContract revisado; este modulo
// constroi o prompt bounded e valida estritamente o output UNTRUSTED:
// shape/bounds aqui, invariantes de lifecycle (runID/budget/round) no kernel.
// validation != generation: nunca repara contrato invalido silenciosamente.

import {
  CONTRACT_LIMITS,
  EVIDENCE_LIMITS,
  OrchestrationError,
  truncate,
  validateExecutionContract,
  type ExecutionContract,
  type FailureClass,
} from "./types.ts";

/**
 * Cap do output bruto do orchestrator. Justificado pelos limites maximos de
 * um ExecutionContract valido: objective 2000 + arrays 50x(500|300) (~65k) +
 * chaves/JSON overhead, com ~2x de folga. Nunca infinito.
 */
export const MAX_REPLAN_OUTPUT = 128_000;

const ALLOWED_TOP_FIELDS = [
  "runID",
  "objective",
  "scope",
  "constraints",
  "acceptanceCriteria",
  "requiredEvidence",
  "maxRounds",
] as const;

const ALLOWED_SCOPE_FIELDS = ["include", "exclude"] as const;

export interface ReplanPromptInput {
  contract: ExecutionContract;
  round: number;
  failureClass: FailureClass;
  previousResultSummary: string;
  failedChecks: Array<{ name: string; status: "pass" | "fail" | "unknown"; summary?: string }>;
  criticFindings: Array<{ severity: "critical" | "important" | "minor"; summary: string }>;
  /** maxRounds vigente (teto — nunca aumenta). */
  maxRounds: number;
}

/** Prompt bounded do orchestrator: invariantes + falha observada, sem raw conversation. */
export function buildReplanPrompt(input: ReplanPromptInput): string {
  const c = input.contract;
  const lines: string[] = [];
  const push = (label: string, value: string) => lines.push(`${label}: ${value}`);
  const pushList = (label: string, items: string[] | undefined) => {
    if (items && items.length > 0) {
      lines.push(`${label}:`);
      for (const it of items) lines.push(`- ${truncate(it, CONTRACT_LIMITS.phrase)}`);
    }
  };

  push("REPLAN_ACTION", "propose-revised-contract");
  push("RUN_ID_MUST_REMAIN", c.runID);
  push("CURRENT_ROUND", `${input.round}`);
  push("MAX_ROUNDS_CANNOT_INCREASE", `${input.maxRounds}`);
  push("REVISED_MAX_ROUNDS_MUST_BE", `>= ${input.round} and <= ${input.maxRounds}`);
  push("OBJECTIVE", truncate(c.objective, CONTRACT_LIMITS.objective));
  pushList("SCOPE_INCLUDE", c.scope?.include);
  pushList("SCOPE_EXCLUDE", c.scope?.exclude);
  pushList("CONSTRAINTS", c.constraints);
  pushList("ACCEPTANCE_CRITERIA", c.acceptanceCriteria);
  pushList("REQUIRED_EVIDENCE", c.requiredEvidence);
  push("PREVIOUS_FAILURE_CLASS", input.failureClass);
  push("PREVIOUS_RESULT_SUMMARY", truncate(input.previousResultSummary || "[sem summary]", EVIDENCE_LIMITS.resultSummary));

  const failedChecks = input.failedChecks.slice(0, EVIDENCE_LIMITS.checks);
  if (failedChecks.length > 0) {
    lines.push("FAILED_OR_UNKNOWN_CHECKS:");
    for (const ck of failedChecks) {
      lines.push(`- ${truncate(ck.name, EVIDENCE_LIMITS.checkName)}: ${ck.status}${ck.summary ? ` (${truncate(ck.summary, EVIDENCE_LIMITS.checkSummary)})` : ""}`);
    }
  }

  const findings = input.criticFindings.slice(0, EVIDENCE_LIMITS.findings);
  if (findings.length > 0) {
    lines.push("CRITIC_FINDINGS:");
    for (const f of findings) {
      lines.push(`- ${f.severity}: ${truncate(f.summary, EVIDENCE_LIMITS.finding)}`);
    }
  }

  lines.push("RULES:");
  lines.push("- produce exactly one revised ExecutionContract as JSON (object or single ```json fence, no other text);");
  lines.push("- no agent;");
  lines.push("- no model;");
  lines.push("- no subcontracts, children, fan-out or parallel contracts;");
  lines.push("- no approval, verdict or reasoning fields;");
  lines.push("- keep runID identical; never increase maxRounds.");
  return lines.join("\n");
}

function failReplan(msg: string): never {
  throw new OrchestrationError("invalid-replan", `revised contract rejeitado: ${msg}`);
}

/**
 * Valida estritamente o output UNTRUSTED do orchestrator e devolve o
 * ExecutionContract normalizado (somente campos permitidos). Rejeita:
 * oversized, fence multiplo/prose, trailing prose, unknown fields (top e
 * scope), shape invalido. Invariantes cross-version (runID/budget/round)
 * pertencem ao kernel (CONTRACT_READY), nao ao parser.
 */
export function parseRevisedContract(raw: unknown): ExecutionContract {
  if (typeof raw !== "string") {
    failReplan("output precisa ser texto");
  }
  if (raw.length > MAX_REPLAN_OUTPUT) {
    failReplan(`output excede o limite de ${MAX_REPLAN_OUTPUT} chars (recebido ${raw.length})`);
  }
  const text = raw.trim();
  if (!text) {
    failReplan("output vazio");
  }
  let jsonText = text;
  const fenceOpen = text.indexOf("```");
  if (fenceOpen >= 0) {
    // UM unico fenced block, sem texto adicional antes/depois (so whitespace).
    const before = text.slice(0, fenceOpen).trim();
    if (before) {
      failReplan("texto antes do fenced block (prose nao permitida)");
    }
    const fenceRe = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/;
    const m = fenceRe.exec(text);
    if (!m) {
      failReplan("fenced block invalido: use um unico ```json ... ``` sem texto adicional");
    }
    jsonText = m[1].trim();
    if (!jsonText) {
      failReplan("fenced block vazio");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    if (jsonText.trimStart().startsWith("{")) {
      failReplan("conteudo apos o JSON (trailing prose nao permitida)");
    }
    failReplan("output nao e JSON valido");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failReplan("output precisa ser um objeto JSON");
  }
  const rec = parsed as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(ALLOWED_TOP_FIELDS as readonly string[]).includes(key)) {
      failReplan(`campo top-level desconhecido: "${key}"`);
    }
  }
  const scope = rec.scope;
  if (scope !== undefined) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      failReplan("scope precisa ser objeto");
    }
    for (const key of Object.keys(scope as Record<string, unknown>)) {
      if (!(ALLOWED_SCOPE_FIELDS as readonly string[]).includes(key)) {
        failReplan(`campo desconhecido em scope: "${key}"`);
      }
    }
  }
  const projected: Record<string, unknown> = {
    runID: rec.runID,
    objective: rec.objective,
    scope: rec.scope,
    constraints: rec.constraints,
    acceptanceCriteria: rec.acceptanceCriteria,
    requiredEvidence: rec.requiredEvidence,
    maxRounds: rec.maxRounds,
  };
  try {
    validateExecutionContract(projected);
  } catch (err) {
    failReplan(err instanceof Error ? err.message : String(err));
  }
  return projected as ExecutionContract;
}
