// Correction prompt de recovery (repair-same / fresh-same).
//
// Puro e testavel: nao importa ctx. Gera o prompt bounded de correcao para a
// proxima rodada APOS um JevVerdict repair-same/fresh-same. Contem SOMENTE a
// falha observada projetada (classes, summary, checks falhos, findings) —
// nunca: chain-of-thought, raw message history, raw critic output nem
// contexto inteiro da worker. Para fresh-same este prompt E a unica informacao
// de recovery alem do contrato bounded: a conversa/sessao antiga nao e copiada.

import { CONTRACT_LIMITS, EVIDENCE_LIMITS, truncate, type ExecutionContract, type FailureClass } from "./types.ts";

export interface RecoveryPromptInput {
  action: "repair-same" | "fresh-same";
  contract: ExecutionContract;
  round: number;
  maxRounds: number;
  failureClass: FailureClass;
  previousResultSummary: string;
  failedChecks: Array<{ name: string; status: "pass" | "fail" | "unknown"; summary?: string }>;
  criticFindings: Array<{ severity: "critical" | "important" | "minor"; summary: string }>;
}

/** Gera o correction prompt bounded focado somente na falha observada. */
export function buildRecoveryPrompt(input: RecoveryPromptInput): string {
  const c = input.contract;
  const lines: string[] = [];
  const push = (label: string, value: string) => lines.push(`${label}: ${value}`);
  const pushList = (label: string, items: string[] | undefined) => {
    if (items && items.length > 0) {
      lines.push(`${label}:`);
      for (const it of items) lines.push(`- ${truncate(it, CONTRACT_LIMITS.phrase)}`);
    }
  };

  push("RECOVERY_ACTION", input.action);
  push("ROUND", `${input.round}/${input.maxRounds}`);
  push("OBJECTIVE", truncate(c.objective, CONTRACT_LIMITS.objective));
  pushList("ACCEPTANCE_CRITERIA", c.acceptanceCriteria);
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

  lines.push("RULE: Correct the observed failure only. Do not declare the work approved. The external judge decides acceptance.");
  return lines.join("\n");
}